import type { MusicTrack } from "../domain/types.js";

export type SearchSource = "ytmsearch" | "ytsearch";
export type TrackLoadType = "empty" | "error" | "playlist" | "search" | "track";

export interface TrackLoadResult {
  loadType: TrackLoadType;
  tracks: MusicTrack[];
}

export interface TrackLoader {
  load(query: string, requesterId: string, source?: SearchSource): Promise<TrackLoadResult>;
}

