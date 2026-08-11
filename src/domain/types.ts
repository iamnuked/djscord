export type TrackOrigin = "requested" | "recommended";

export interface MusicTrack {
  author: string;
  durationMs: number;
  identifier: string;
  isSeekable: boolean;
  isStream: boolean;
  origin: TrackOrigin;
  requesterId?: string;
  title: string;
  uri: string;
}

export interface GuildPlaybackState {
  autoplayEnabled: boolean;
  recentTrackIds: string[];
}

