import { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import type { GuildSettings, MusicTrack } from "../domain/types.js";

const MAX_PLAYLIST_TRACKS = 100;
const MAX_PLAYLIST_NAME_LENGTH = 40;

const musicTrackSchema = z.object({
  artworkUrl: z.string().nullable().optional(),
  author: z.string(),
  durationMs: z.number().nonnegative(),
  encoded: z.string().optional(),
  identifier: z.string().min(1),
  isSeekable: z.boolean(),
  isStream: z.boolean(),
  origin: z.enum(["requested", "genre", "recommended"]),
  requesterId: z.string().optional(),
  sourceName: z.string().optional(),
  title: z.string(),
  uri: z.string().min(1)
});

export interface SavedPlaylist {
  name: string;
  tracks: MusicTrack[];
}

export interface SavedPlaylistSummary {
  name: string;
  trackCount: number;
}

interface GuildSettingsRow {
  autoplay_default: number;
  default_volume: number;
}

interface PlaylistIdRow {
  id: number;
}

interface PlaylistSummaryRow {
  name: string;
  track_count: number;
}

interface TrackJsonRow {
  track_json: string;
}

export class SqliteMusicRepository {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(path: string) {
    this.#database = new DatabaseSync(path, { timeout: 5_000 });
    this.#database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id TEXT PRIMARY KEY,
        default_volume INTEGER NOT NULL CHECK (default_volume BETWEEN 0 AND 100),
        autoplay_default INTEGER NOT NULL CHECK (autoplay_default IN (0, 1))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS favorites (
        user_id TEXT NOT NULL,
        track_identifier TEXT NOT NULL,
        track_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, track_identifier)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (guild_id, user_id, name)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS playlist_tracks (
        playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        track_json TEXT NOT NULL,
        PRIMARY KEY (playlist_id, position)
      ) STRICT;
    `);
  }

  getGuildSettings(guildId: string): GuildSettings | undefined {
    const row = this.#database
      .prepare(
        "SELECT default_volume, autoplay_default FROM guild_settings WHERE guild_id = ?"
      )
      .get(guildId) as GuildSettingsRow | undefined;
    if (row === undefined) return undefined;
    return {
      autoplayDefault: row.autoplay_default === 1,
      defaultVolume: row.default_volume
    };
  }

  saveGuildSettings(guildId: string, settings: GuildSettings): void {
    this.#database
      .prepare(`
        INSERT INTO guild_settings (guild_id, default_volume, autoplay_default)
        VALUES (?, ?, ?)
        ON CONFLICT (guild_id) DO UPDATE SET
          default_volume = excluded.default_volume,
          autoplay_default = excluded.autoplay_default
      `)
      .run(guildId, settings.defaultVolume, settings.autoplayDefault ? 1 : 0);
  }

  addFavorite(userId: string, track: MusicTrack): boolean {
    const result = this.#database
      .prepare(`
        INSERT OR IGNORE INTO favorites (user_id, track_identifier, track_json, created_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(userId, track.identifier, serializeTrack(track), Date.now());
    return result.changes === 1;
  }

  listFavorites(userId: string, limit: number): MusicTrack[] {
    validateListLimit(limit);
    const rows = this.#database
      .prepare(`
        SELECT track_json
        FROM favorites
        WHERE user_id = ?
        ORDER BY created_at DESC, track_identifier ASC
        LIMIT ?
      `)
      .all(userId, limit) as unknown as TrackJsonRow[];
    return rows.map(({ track_json }) => deserializeTrack(track_json));
  }

  savePlaylist(
    guildId: string,
    userId: string,
    name: string,
    tracks: readonly MusicTrack[]
  ): "created" | "replaced" {
    const normalizedName = normalizePlaylistName(name);
    if (tracks.length < 1) {
      throw new Error("플레이리스트에는 한 곡 이상 필요합니다.");
    }
    if (tracks.length > MAX_PLAYLIST_TRACKS) {
      throw new Error("플레이리스트는 최대 100곡까지 저장할 수 있습니다.");
    }

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#database
        .prepare("SELECT id FROM playlists WHERE guild_id = ? AND user_id = ? AND name = ?")
        .get(guildId, userId, normalizedName) as PlaylistIdRow | undefined;
      const status = existing === undefined ? "created" : "replaced";
      let playlistId: number;
      if (existing === undefined) {
        const inserted = this.#database
          .prepare(`
            INSERT INTO playlists (guild_id, user_id, name, created_at)
            VALUES (?, ?, ?, ?)
          `)
          .run(guildId, userId, normalizedName, Date.now());
        playlistId = Number(inserted.lastInsertRowid);
      } else {
        playlistId = existing.id;
        this.#database
          .prepare("DELETE FROM playlist_tracks WHERE playlist_id = ?")
          .run(playlistId);
      }

      const insertTrack = this.#database.prepare(`
        INSERT INTO playlist_tracks (playlist_id, position, track_json)
        VALUES (?, ?, ?)
      `);
      tracks.forEach((track, index) => {
        insertTrack.run(playlistId, index, serializeTrack(track));
      });
      this.#database.exec("COMMIT");
      return status;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  getPlaylist(guildId: string, userId: string, name: string): SavedPlaylist | undefined {
    const normalizedName = normalizePlaylistName(name);
    const playlist = this.#database
      .prepare("SELECT id FROM playlists WHERE guild_id = ? AND user_id = ? AND name = ?")
      .get(guildId, userId, normalizedName) as PlaylistIdRow | undefined;
    if (playlist === undefined) return undefined;
    const rows = this.#database
      .prepare(`
        SELECT track_json
        FROM playlist_tracks
        WHERE playlist_id = ?
        ORDER BY position ASC
      `)
      .all(playlist.id) as unknown as TrackJsonRow[];
    return {
      name: normalizedName,
      tracks: rows.map(({ track_json }) => deserializeTrack(track_json))
    };
  }

  listPlaylists(guildId: string, userId: string): SavedPlaylistSummary[] {
    const rows = this.#database
      .prepare(`
        SELECT playlists.name, COUNT(playlist_tracks.position) AS track_count
        FROM playlists
        LEFT JOIN playlist_tracks ON playlist_tracks.playlist_id = playlists.id
        WHERE playlists.guild_id = ? AND playlists.user_id = ?
        GROUP BY playlists.id
        ORDER BY playlists.created_at DESC, playlists.name ASC
        LIMIT 20
      `)
      .all(guildId, userId) as unknown as PlaylistSummaryRow[];
    return rows.map((row) => ({ name: row.name, trackCount: row.track_count }));
  }

  deletePlaylist(guildId: string, userId: string, name: string): boolean {
    const normalizedName = normalizePlaylistName(name);
    const result = this.#database
      .prepare("DELETE FROM playlists WHERE guild_id = ? AND user_id = ? AND name = ?")
      .run(guildId, userId, normalizedName);
    return result.changes === 1;
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }
}

function normalizePlaylistName(name: string): string {
  const normalized = name.trim();
  if (normalized.length < 1 || normalized.length > MAX_PLAYLIST_NAME_LENGTH) {
    throw new Error("플레이리스트 이름은 1~40자로 입력해주세요.");
  }
  return normalized;
}

function validateListLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("조회 개수는 1부터 100 사이여야 합니다.");
  }
}

function serializeTrack(track: MusicTrack): string {
  return JSON.stringify(track);
}

function deserializeTrack(value: string): MusicTrack {
  return musicTrackSchema.parse(JSON.parse(value)) as MusicTrack;
}
