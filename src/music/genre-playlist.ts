import type { MusicTrack } from "../domain/types.js";
import type { TrackLoader } from "./ports.js";

export interface GenerateGenrePlaylistOptions {
  count: number;
  excludedTrackIds: ReadonlySet<string>;
  genre: string;
  requesterId: string;
}

export interface GeneratedGenrePlaylist {
  missingCount: number;
  tracks: MusicTrack[];
}

export class GenrePlaylistService {
  readonly #loader: Pick<TrackLoader, "load">;

  constructor(loader: Pick<TrackLoader, "load">) {
    this.#loader = loader;
  }

  async generate(options: GenerateGenrePlaylistOptions): Promise<GeneratedGenrePlaylist> {
    if (options.count < 5 || options.count > 30) {
      throw new Error("곡수는 5곡에서 30곡 사이여야 합니다.");
    }

    const genre = options.genre.trim();
    if (genre.length === 0) {
      throw new Error("장르 이름을 입력해주세요.");
    }

    let searchTracks: MusicTrack[] = [];
    try {
      const result = await this.#loader.load(
        `${genre} 음악`,
        options.requesterId,
        "ytmsearch"
      );
      searchTracks = result.tracks.filter(isPlayableYoutubeTrack);
    } catch {
      searchTracks = [];
    }

    if (searchTracks.length === 0) {
      const result = await this.#loader.load(`${genre} music`, options.requesterId, "ytsearch");
      searchTracks = result.tracks.filter(isPlayableYoutubeTrack);
    }

    const seed = searchTracks[0];
    if (seed === undefined) {
      throw new Error("장르에 맞는 곡을 찾지 못했습니다.");
    }

    let mixTracks: MusicTrack[] = [];
    try {
      const mixUrl = `https://www.youtube.com/watch?v=${seed.identifier}&list=RD${seed.identifier}`;
      const result = await this.#loader.load(mixUrl, options.requesterId, undefined);
      mixTracks = result.tracks.filter(isPlayableYoutubeTrack);
    } catch {
      mixTracks = [];
    }

    const candidates = [seed, ...mixTracks, ...searchTracks.slice(1)];
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

    return {
      missingCount: options.count - tracks.length,
      tracks
    };
  }
}

function isPlayableYoutubeTrack(track: MusicTrack): boolean {
  return track.encoded !== undefined && !track.isStream && track.sourceName === "youtube";
}
