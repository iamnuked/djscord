import type { MusicTrack } from "../domain/types.js";
import {
  resolveLastFmGenreTag,
  resolveGenreSeedProfile,
  type GenreArtistSeed
} from "./genre-seeds.js";
import type { GenreArtistProvider, TrackLoader } from "./ports.js";

const LASTFM_ARTIST_LIMIT = 6;

export interface GenerateGenrePlaylistOptions {
  count: number;
  excludedTrackIds: ReadonlySet<string>;
  genre: string;
  requesterId: string;
}

export interface GeneratedGenrePlaylist {
  missingCount: number;
  source: "curated" | "lastfm" | "youtube";
  tracks: MusicTrack[];
}

export class GenrePlaylistService {
  readonly #artistProvider: GenreArtistProvider | undefined;
  readonly #loader: Pick<TrackLoader, "load">;

  constructor(loader: Pick<TrackLoader, "load">, artistProvider?: GenreArtistProvider) {
    this.#loader = loader;
    this.#artistProvider = artistProvider;
  }

  async generate(options: GenerateGenrePlaylistOptions): Promise<GeneratedGenrePlaylist> {
    if (options.count < 5 || options.count > 30) {
      throw new Error("곡수는 5곡에서 30곡 사이여야 합니다.");
    }

    const genre = options.genre.trim();
    if (genre.length === 0) {
      throw new Error("장르 이름을 입력해주세요.");
    }

    const profile = resolveGenreSeedProfile(genre);
    let seedSource: GeneratedGenrePlaylist["source"] =
      profile === undefined ? "youtube" : "curated";
    let artistSeeds: readonly GenreArtistSeed[] = profile?.seeds ?? [];

    if (profile === undefined && this.#artistProvider !== undefined) {
      try {
        const artists = await this.#artistProvider.getTopArtists(
          resolveLastFmGenreTag(genre),
          LASTFM_ARTIST_LIMIT
        );
        artistSeeds = artists.map(toArtistSeed);
        if (artistSeeds.length > 0) {
          seedSource = "lastfm";
        }
      } catch {
        artistSeeds = [];
      }
    }

    let candidates = await this.#loadCuratedCandidates(artistSeeds, options.requesterId);
    let tracks = selectTracks(candidates, options);

    if (tracks.length < options.count) {
      let genericCandidates: MusicTrack[] = [];
      try {
        genericCandidates = await this.#loadGenericCandidates(
          profile?.id ?? genre,
          options.requesterId
        );
      } catch (error) {
        if (tracks.length === 0) {
          throw error;
        }
      }

      candidates = [...candidates, ...genericCandidates];
      tracks = selectTracks(candidates, options);
    }

    if (tracks.length === 0) {
      throw new Error("장르에 맞는 곡을 찾지 못했습니다.");
    }

    return {
      missingCount: options.count - tracks.length,
      source: seedSource,
      tracks
    };
  }

  async #loadCuratedCandidates(
    seedsToSearch: readonly GenreArtistSeed[],
    requesterId: string
  ): Promise<MusicTrack[]> {
    const searchedSeeds = await Promise.all(
      seedsToSearch.map(async (seed) => this.#loadArtistSeed(seed, requesterId))
    );
    const seeds = searchedSeeds.filter((track): track is MusicTrack => track !== undefined);

    const mixes = await Promise.all(
      seeds.map(async (seed) => {
        const mixTracks = await this.#loadMix(seed, requesterId);
        return mixTracks.filter((track) => track.identifier !== seed.identifier);
      })
    );

    return [...seeds, ...roundRobin(mixes)];
  }

  async #loadArtistSeed(
    seed: GenreArtistSeed,
    requesterId: string
  ): Promise<MusicTrack | undefined> {
    for (const source of ["ytmsearch", "ytsearch"] as const) {
      try {
        const result = await this.#loader.load(seed.query, requesterId, source);
        const match = result.tracks
          .filter(isPlayableYoutubeTrack)
          .find((track) => matchesArtist(track, seed.aliases));
        if (match !== undefined) {
          return match;
        }
      } catch {
        // 한 아티스트 검색 실패가 전체 장르 생성을 중단시키지 않게 다음 소스를 시도한다.
      }
    }

    return undefined;
  }

  async #loadGenericCandidates(genre: string, requesterId: string): Promise<MusicTrack[]> {
    const searchTracks = await this.#loadGenreSearch(genre, requesterId);
    const seed = searchTracks[0];
    if (seed === undefined) {
      throw new Error("장르에 맞는 곡을 찾지 못했습니다.");
    }

    const mixTracks = await this.#loadMix(seed, requesterId);
    return [seed, ...mixTracks, ...searchTracks.slice(1)];
  }

  async #loadGenreSearch(genre: string, requesterId: string): Promise<MusicTrack[]> {
    let searchTracks: MusicTrack[] = [];
    try {
      const result = await this.#loader.load(
        `${genre} 음악`,
        requesterId,
        "ytmsearch"
      );
      searchTracks = result.tracks.filter(isPlayableYoutubeTrack);
    } catch {
      searchTracks = [];
    }

    if (searchTracks.length === 0) {
      const result = await this.#loader.load(`${genre} music`, requesterId, "ytsearch");
      searchTracks = result.tracks.filter(isPlayableYoutubeTrack);
    }

    return searchTracks;
  }

  async #loadMix(seed: MusicTrack, requesterId: string): Promise<MusicTrack[]> {
    try {
      const mixUrl = `https://www.youtube.com/watch?v=${seed.identifier}&list=RD${seed.identifier}`;
      const result = await this.#loader.load(mixUrl, requesterId, undefined);
      return result.tracks.filter(isPlayableYoutubeTrack);
    } catch {
      return [];
    }
  }
}

function toArtistSeed(artist: string): GenreArtistSeed {
  return {
    aliases: [artist],
    artist,
    query: `${artist} official music video`
  };
}

function selectTracks(
  candidates: readonly MusicTrack[],
  options: GenerateGenrePlaylistOptions
): MusicTrack[] {
  const seen = new Set<string>();
  const tracks: MusicTrack[] = [];

  for (const candidate of candidates) {
    if (
      tracks.length >= options.count ||
      seen.has(candidate.identifier) ||
      options.excludedTrackIds.has(candidate.identifier)
    ) {
      continue;
    }

    seen.add(candidate.identifier);
    tracks.push({
      ...candidate,
      origin: "genre",
      requesterId: options.requesterId
    });
  }

  return tracks;
}

function roundRobin(groups: readonly (readonly MusicTrack[])[]): MusicTrack[] {
  const tracks: MusicTrack[] = [];
  const longestGroup = Math.max(0, ...groups.map(({ length }) => length));

  for (let index = 0; index < longestGroup; index += 1) {
    for (const group of groups) {
      const track = group[index];
      if (track !== undefined) {
        tracks.push(track);
      }
    }
  }

  return tracks;
}

function isPlayableYoutubeTrack(track: MusicTrack): boolean {
  return track.encoded !== undefined && !track.isStream && track.sourceName === "youtube";
}

function matchesArtist(track: MusicTrack, aliases: readonly string[]): boolean {
  const metadata = `${track.author} ${track.title}`.normalize("NFKC").toLocaleLowerCase("en-US");
  const tokens = metadata.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const compactMetadata = tokens.join("");

  return aliases.some((alias) => {
    const normalizedAlias = alias.normalize("NFKC").toLocaleLowerCase("en-US");
    const aliasTokens = normalizedAlias.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const compactAlias = aliasTokens.join("");

    if (aliasTokens.length === 1 && /^[a-z0-9]{1,3}$/.test(compactAlias)) {
      return tokens.includes(compactAlias);
    }

    return compactAlias.length > 0 && compactMetadata.includes(compactAlias);
  });
}
