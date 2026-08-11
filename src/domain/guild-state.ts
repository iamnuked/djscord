import type { GuildPlaybackState } from "./types.js";

const RECENT_TRACK_LIMIT = 20;

export class GuildStateStore {
  readonly #states = new Map<string, GuildPlaybackState>();

  getOrCreate(guildId: string): GuildPlaybackState {
    const existing = this.#states.get(guildId);
    if (existing !== undefined) {
      return existing;
    }

    const created: GuildPlaybackState = {
      autoplayEnabled: true,
      recentTrackIds: []
    };
    this.#states.set(guildId, created);
    return created;
  }

  rememberTrack(guildId: string, identifier: string): void {
    const state = this.getOrCreate(guildId);
    state.recentTrackIds.push(identifier);
    if (state.recentTrackIds.length > RECENT_TRACK_LIMIT) {
      state.recentTrackIds.splice(0, state.recentTrackIds.length - RECENT_TRACK_LIMIT);
    }
  }

  delete(guildId: string): void {
    this.#states.delete(guildId);
  }
}
