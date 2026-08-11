import { z } from "zod";

import type { GenreArtistProvider } from "../music/ports.js";

const LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/";
const DEFAULT_CACHE_TTL_MS = 86_400_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_USER_AGENT = "djscord-music-bot/0.1.0";
const MAX_CACHE_ENTRIES = 100;

const lastFmErrorSchema = z.object({
  error: z.number(),
  message: z.string()
});

const topArtistsSchema = z.object({
  topartists: z.object({
    artist: z.array(z.object({ name: z.string() }))
  })
});

interface LastFmGenreArtistProviderOptions {
  apiKey: string;
  cacheTtlMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
  userAgent?: string;
}

interface CacheEntry {
  artists: string[];
  expiresAt: number;
}

export class LastFmGenreArtistProvider implements GenreArtistProvider {
  readonly #apiKey: string;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #cacheTtlMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #requestTimeoutMs: number;
  readonly #userAgent: string;

  constructor(options: LastFmGenreArtistProviderOptions) {
    const apiKey = options.apiKey.trim();
    if (apiKey.length === 0) {
      throw new Error("Last.fm API 키가 필요합니다.");
    }

    this.#apiKey = apiKey;
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  async getTopArtists(genre: string, limit: number): Promise<string[]> {
    const tag = normalizeTag(genre);
    if (tag.length === 0) {
      throw new Error("Last.fm 장르 태그를 입력해주세요.");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new Error("Last.fm 아티스트 요청 수는 1명에서 50명 사이여야 합니다.");
    }

    const cacheKey = `${tag}:${limit}`;
    const now = this.#now();
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined && now < cached.expiresAt) {
      return [...cached.artists];
    }

    const url = new URL(LASTFM_API_URL);
    url.searchParams.set("method", "tag.gettopartists");
    url.searchParams.set("tag", tag);
    url.searchParams.set("api_key", this.#apiKey);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("page", "1");

    const response = await this.#fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": this.#userAgent
      },
      signal: AbortSignal.timeout(this.#requestTimeoutMs)
    });
    if (!response.ok) {
      throw new Error(`Last.fm 요청에 실패했습니다 (${response.status}).`);
    }

    const body: unknown = await response.json();
    const lastFmError = lastFmErrorSchema.safeParse(body);
    if (lastFmError.success) {
      throw new Error(
        `Last.fm API 오류 (${lastFmError.data.error}): ${lastFmError.data.message}`
      );
    }

    const parsed = topArtistsSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error("Last.fm 응답 형식을 이해할 수 없습니다.");
    }

    const artists = uniqueArtistNames(
      parsed.data.topartists.artist.map(({ name }) => name)
    );
    this.#cache.set(cacheKey, {
      artists,
      expiresAt: now + this.#cacheTtlMs
    });
    this.#trimCache();
    return [...artists];
  }

  #trimCache(): void {
    while (this.#cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = this.#cache.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        return;
      }
      this.#cache.delete(oldestKey);
    }
  }
}

function normalizeTag(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function uniqueArtistNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const artists: string[] = [];

  for (const rawName of names) {
    const name = rawName.trim();
    const key = name.normalize("NFKC").toLocaleLowerCase("en-US");
    if (name.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    artists.push(name);
  }

  return artists;
}
