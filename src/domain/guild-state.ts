import type { GuildPlaybackState, GuildSettings } from "./types.js";

const RECENT_TRACK_LIMIT = 20;

export interface GuildSettingsPersistence {
  getGuildSettings(guildId: string): GuildSettings | undefined;
  saveGuildSettings(guildId: string, settings: GuildSettings): void;
}

export class GuildStateStore {
  readonly #persistence: GuildSettingsPersistence | undefined;
  readonly #states = new Map<string, GuildPlaybackState>();

  constructor(persistence?: GuildSettingsPersistence) {
    this.#persistence = persistence;
  }

  getOrCreate(guildId: string): GuildPlaybackState {
    const existing = this.#states.get(guildId);
    if (existing !== undefined) {
      return existing;
    }

    const saved = this.#persistence?.getGuildSettings(guildId);
    const autoplayDefault = saved?.autoplayDefault ?? true;
    const created: GuildPlaybackState = {
      autoplayDefault,
      autoplayEnabled: autoplayDefault,
      defaultVolume: saved?.defaultVolume ?? 100,
      recentTrackIds: []
    };
    this.#states.set(guildId, created);
    return created;
  }

  updateSettings(guildId: string, settings: Partial<GuildSettings>): GuildPlaybackState {
    const state = this.getOrCreate(guildId);
    if (settings.defaultVolume !== undefined) {
      if (!Number.isInteger(settings.defaultVolume) || settings.defaultVolume < 0 || settings.defaultVolume > 100) {
        throw new Error("기본 볼륨은 0부터 100 사이의 정수여야 합니다.");
      }
      state.defaultVolume = settings.defaultVolume;
    }
    if (settings.autoplayDefault !== undefined) {
      state.autoplayDefault = settings.autoplayDefault;
      state.autoplayEnabled = settings.autoplayDefault;
    }
    this.#persistence?.saveGuildSettings(guildId, {
      autoplayDefault: state.autoplayDefault,
      defaultVolume: state.defaultVolume
    });
    return state;
  }

  resetSession(guildId: string): void {
    const state = this.getOrCreate(guildId);
    state.autoplayEnabled = state.autoplayDefault;
    state.recentTrackIds = [];
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
