import type { MusicTrack } from "../domain/types.js";

export type SearchSource = "ytmsearch" | "ytsearch";
export type TrackLoadType = "empty" | "error" | "playlist" | "search" | "track";

export interface TrackLoadResult {
  loadType: TrackLoadType;
  tracks: MusicTrack[];
  unavailableCount?: number;
}

export interface TrackLoader {
  load(query: string, requesterId: string, source?: SearchSource): Promise<TrackLoadResult>;
}

export interface GenreArtistProvider {
  getTopArtists(genre: string, limit: number): Promise<string[]>;
}
