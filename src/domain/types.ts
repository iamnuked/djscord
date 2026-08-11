export type TrackOrigin = "requested" | "recommended";

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
  autoplayEnabled: boolean;
  recentTrackIds: string[];
}
