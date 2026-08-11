import type { SearchResult, Track, UnresolvedSearchResult, UnresolvedTrack } from "lavalink-client";
import { describe, expect, it, vi } from "vitest";

import { LavalinkTrackLoader } from "../src/infrastructure/lavalink-track-loader.js";

function rawTrack(identifier: string): Track {
  return {
    encoded: `encoded-${identifier}`,
    info: {
      artworkUrl: null,
      author: "artist",
      duration: 180_000,
      identifier,
      isSeekable: true,
      isStream: false,
      isrc: null,
      sourceName: "youtube",
      title: `track-${identifier}`,
      uri: `https://youtube.com/watch?v=${identifier}`
    },
    pluginInfo: {},
    requester: { id: "user-1" }
  };
}

describe("LavalinkTrackLoader", () => {
  it("검색 소스와 요청자를 Lavalink Player에 전달하고 도메인 트랙으로 변환한다", async () => {
    const sourceTrack = rawTrack("one");
    const search = vi.fn().mockResolvedValue({
      exception: null,
      loadType: "search",
      playlist: null,
      pluginInfo: {},
      tracks: [sourceTrack]
    } satisfies SearchResult);
    const loader = new LavalinkTrackLoader({ search });

    const result = await loader.load("아이유 좋은 날", "user-1", "ytmsearch");

    expect(search).toHaveBeenCalledWith(
      { query: "아이유 좋은 날", source: "ytmsearch" },
      { id: "user-1" },
      false
    );
    expect(result.tracks[0]).toMatchObject({
      identifier: "one",
      origin: "requested",
      requesterId: "user-1",
      title: "track-one"
    });
    expect(loader.toLavalinkTrack(result.tracks[0]!)).toBe(sourceTrack);
  });

  it("자동재생 요청자는 추천 출처로 표시한다", async () => {
    const search = vi.fn().mockResolvedValue({
      exception: null,
      loadType: "playlist",
      playlist: null,
      pluginInfo: {},
      tracks: [rawTrack("recommended")]
    } satisfies SearchResult);
    const loader = new LavalinkTrackLoader({ search });

    const result = await loader.load("mix-url", "autoplay", undefined);

    expect(result.tracks[0]).toMatchObject({ origin: "recommended" });
    expect(result.tracks[0]?.requesterId).toBeUndefined();
  });

  it("해석되지 않은 트랙은 정상 트랙으로 오인하지 않고 재생 불가로 센다", async () => {
    const unavailableTrack = {
      encoded: "encoded-private",
      info: { title: "Private video" },
      pluginInfo: {},
      requester: { id: "user-1" },
      resolve: vi.fn()
    } satisfies UnresolvedTrack;
    const search = vi.fn().mockResolvedValue({
      exception: null,
      loadType: "playlist",
      playlist: null,
      pluginInfo: {},
      tracks: [unavailableTrack]
    } satisfies UnresolvedSearchResult);
    const loader = new LavalinkTrackLoader({ search });

    const result = await loader.load("playlist-url", "user-1", undefined);

    expect(result.tracks).toEqual([]);
    expect(result.unavailableCount).toBe(1);
  });
});
