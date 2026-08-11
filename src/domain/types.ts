export type TrackOrigin = "requested" | "genre" | "recommended";
export type RecommendationFeedback = "dislike" | "like";

export interface MusicTrack {
  artworkUrl?: string | null;
  author: string;
  durationMs: number;
  encoded?: string;
  identifier: string;
  isSeekable: boolean;
  isStream: boolean;
  origin: TrackOrigin;
  requesterId?: string;
  sourceName?: string;
  title: string;
  uri: string;
}

export interface GuildPlaybackState {
  autoplayDefault: boolean;
  autoplayEnabled: boolean;
  defaultVolume: number;
  recentTrackIds: string[];
}

export interface GuildSettings {
  autoplayDefault: boolean;
  defaultVolume: number;
}
