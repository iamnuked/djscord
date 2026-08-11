import type {
  Player,
  SearchQuery,
  SearchResult,
  Track,
  UnresolvedSearchResult
} from "lavalink-client";

import type { MusicTrack, TrackOrigin } from "../domain/types.js";
import type {
  SearchSource,
  TrackLoader,
  TrackLoadResult,
  TrackLoadType
} from "../music/ports.js";

type SearchPlayer = Pick<Player, "search">;

export class LavalinkTrackLoader implements TrackLoader {
  readonly #player: SearchPlayer;
  readonly #rawTracks = new Map<string, Track>();

  constructor(player: SearchPlayer) {
    this.#player = player;
  }

  async load(
    query: string,
    requesterId: string,
    source?: SearchSource
  ): Promise<TrackLoadResult> {
    const searchQuery: SearchQuery = source === undefined ? query : { query, source };
    const result: SearchResult | UnresolvedSearchResult = await this.#player.search(
      searchQuery,
      { id: requesterId },
      false
    );
    const origin: TrackOrigin = requesterId === "autoplay" ? "recommended" : "requested";
    const tracks = result.tracks.flatMap((rawTrack) => {
      if ("resolve" in rawTrack || rawTrack.encoded === undefined) {
        return [];
      }
      const track = rawTrack;
      const key = trackKey(track.info.identifier, track.encoded);
      this.#rawTracks.set(key, track);
      return [toMusicTrack(track, origin, requesterId)];
    });

    return {
      loadType: result.loadType as TrackLoadType,
      tracks,
      unavailableCount: result.tracks.length - tracks.length
    };
  }

  toLavalinkTrack(track: MusicTrack): Track {
    const rawTrack = this.#rawTracks.get(trackKey(track.identifier, track.encoded));
    if (rawTrack === undefined) {
      throw new Error(`Lavalink 원본 트랙을 찾지 못했습니다: ${track.identifier}`);
    }

    rawTrack.userData = {
      ...rawTrack.userData,
      origin: track.origin,
      ...(track.requesterId === undefined ? {} : { requesterId: track.requesterId })
    };
    return rawTrack;
  }
}

export function fromLavalinkTrack(track: Track): MusicTrack {
  const origin: TrackOrigin =
    track.userData?.origin === "recommended"
      ? "recommended"
      : track.userData?.origin === "genre"
        ? "genre"
        : "requested";
  const requesterId =
    typeof track.userData?.requesterId === "string"
      ? track.userData.requesterId
      : typeof (track.requester as { id?: unknown } | undefined)?.id === "string"
        ? (track.requester as { id: string }).id
        : undefined;

  return {
    artworkUrl: track.info.artworkUrl,
    author: track.info.author,
    durationMs: track.info.duration,
    ...(track.encoded === undefined ? {} : { encoded: track.encoded }),
    identifier: track.info.identifier,
    isSeekable: track.info.isSeekable,
    isStream: track.info.isStream,
    origin,
    ...(origin === "recommended" || requesterId === undefined ? {} : { requesterId }),
    sourceName: track.info.sourceName,
    title: track.info.title,
    uri: track.info.uri
  };
}

function toMusicTrack(track: Track, origin: TrackOrigin, requesterId: string): MusicTrack {
  const base = fromLavalinkTrack(track);
  const trackWithoutRequester = { ...base };
  delete trackWithoutRequester.requesterId;
  return {
    ...trackWithoutRequester,
    origin,
    ...(origin === "recommended" ? {} : { requesterId })
  };
}

function trackKey(identifier: string, encoded?: string): string {
  return `${identifier}:${encoded ?? ""}`;
}
