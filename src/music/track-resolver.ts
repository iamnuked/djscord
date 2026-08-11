import { classifyPlayInput } from "../domain/input.js";
import type { MusicTrack } from "../domain/types.js";
import type { SearchSource, TrackLoader } from "./ports.js";

const PLAYLIST_LIMIT = 50;
const SEARCH_SELECTION_LIMIT = 5;

export interface ResolvedTracks {
  kind: "selection" | "tracks";
  skipped: number;
  tracks: MusicTrack[];
  unavailable: number;
}

export class TrackResolverService {
  readonly #loader: TrackLoader;

  constructor(loader: TrackLoader) {
    this.#loader = loader;
  }

  async resolve(rawInput: string, requesterId: string): Promise<ResolvedTracks> {
    const input = classifyPlayInput(rawInput);
    if (input.kind === "search") {
      const musicResult = await this.#search(input.value, requesterId, "ytmsearch");
      const result =
        musicResult.length > 0
          ? musicResult
          : await this.#search(input.value, requesterId, "ytsearch");

      if (result.length === 0) {
        throw new Error("검색 결과를 찾지 못했습니다.");
      }

      return {
        kind: "selection",
        skipped: 0,
        tracks: result.slice(0, SEARCH_SELECTION_LIMIT),
        unavailable: 0
      };
    }

    const result = await this.#loader.load(input.value, requesterId, undefined);
    if (result.tracks.length === 0) {
      throw new Error("재생할 수 있는 곡을 찾지 못했습니다.");
    }

    const limit = input.kind === "playlist" ? PLAYLIST_LIMIT : 1;
    return {
      kind: "tracks",
      skipped: Math.max(0, result.tracks.length - limit),
      tracks: result.tracks.slice(0, limit),
      unavailable: result.unavailableCount ?? 0
    };
  }

  async #search(query: string, requesterId: string, source: SearchSource): Promise<MusicTrack[]> {
    const result = await this.#loader.load(query, requesterId, source);
    return result.tracks;
  }
}
