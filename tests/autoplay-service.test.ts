import { describe, expect, it, vi } from "vitest";

import type { MusicTrack } from "../src/domain/types.js";
import { AutoplayService } from "../src/music/autoplay-service.js";
import type { TrackLoadResult, TrackLoader } from "../src/music/ports.js";

function track(identifier: string, isStream = false): MusicTrack {
  return {
    author: "artist",
    durationMs: 180_000,
    identifier,
    isSeekable: true,
    isStream,
    origin: "requested",
    title: `track-${identifier}`,
    uri: `https://youtube.com/watch?v=${identifier}`
  };
}

describe("AutoplayService", () => {
  it("마지막 곡 기반 YouTube Mix에서 유효 추천곡을 고른다", async () => {
    const load = vi.fn<TrackLoader["load"]>().mockResolvedValue({
      loadType: "playlist",
      tracks: [track("seed"), track("recent"), track("live", true), track("fresh")]
    } satisfies TrackLoadResult);
    const service = new AutoplayService({ load });

    const selected = await service.recommend({
      enabled: true,
      lastTrack: track("seed"),
      queuedTrackIds: new Set(),
      recentTrackIds: new Set(["recent"])
    });

    expect(load).toHaveBeenCalledWith(
      "https://www.youtube.com/watch?v=seed&list=RDseed",
      "autoplay",
      undefined
    );
    expect(selected?.identifier).toBe("fresh");
    expect(selected?.origin).toBe("recommended");
  });

  it("DJ 믹스의 개별 곡들이 공통으로 추천하는 곡을 우선한다", async () => {
    const load = vi.fn<TrackLoader["load"]>().mockImplementation(async (query) => {
      const identifier = new URL(query).searchParams.get("v");
      const tracksBySeed: Record<string, MusicTrack[]> = {
        "dj-set": [track("dj-set"), track("mix-a"), track("mix-b"), track("mix-c")],
        "mix-a": [track("mix-a"), track("shared"), track("a-only")],
        "mix-b": [track("mix-b"), track("shared"), track("b-only")],
        "mix-c": [track("mix-c"), track("c-only")]
      };
      return {
        loadType: "playlist",
        tracks: tracksBySeed[identifier ?? ""] ?? []
      } satisfies TrackLoadResult;
    });
    const service = new AutoplayService({ load });

    const selected = await service.recommend({
      enabled: true,
      lastTrack: track("dj-set"),
      queuedTrackIds: new Set(),
      recentTrackIds: new Set()
    });

    expect(load).toHaveBeenCalledTimes(4);
    expect(selected?.identifier).toBe("shared");
  });

  it("일부 DJ 믹스 곡의 확장 조회가 실패해도 기본 Mix 후보로 추천한다", async () => {
    const load = vi.fn<TrackLoader["load"]>().mockImplementation(async (query) => {
      const identifier = new URL(query).searchParams.get("v");
      if (identifier === "mix-a") {
        throw new Error("YouTube Mix를 불러오지 못했습니다.");
      }
      return {
        loadType: "playlist",
        tracks: [track("dj-set"), track("mix-a"), track("fresh")]
      } satisfies TrackLoadResult;
    });
    const service = new AutoplayService({ load });

    const selected = await service.recommend({
      enabled: true,
      lastTrack: track("dj-set"),
      queuedTrackIds: new Set(),
      recentTrackIds: new Set()
    });

    expect(selected?.identifier).toBe("mix-a");
  });

  it("자동재생이 꺼져 있으면 Mix를 조회하지 않는다", async () => {
    const load = vi.fn<TrackLoader["load"]>();
    const service = new AutoplayService({ load });

    const selected = await service.recommend({
      enabled: false,
      lastTrack: track("seed"),
      queuedTrackIds: new Set(),
      recentTrackIds: new Set()
    });

    expect(selected).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });

  it("유효 추천곡이 없으면 undefined를 반환한다", async () => {
    const load = vi.fn<TrackLoader["load"]>().mockResolvedValue({
      loadType: "playlist",
      tracks: [track("seed"), track("live", true)]
    } satisfies TrackLoadResult);
    const service = new AutoplayService({ load });

    const selected = await service.recommend({
      enabled: true,
      lastTrack: track("seed"),
      queuedTrackIds: new Set(),
      recentTrackIds: new Set()
    });

    expect(selected).toBeUndefined();
  });

  it("좋아요 곡을 Mix 시드로 사용하고 싫어요 후보를 제외한다", async () => {
    const load = vi.fn<TrackLoader["load"]>().mockResolvedValue({
      loadType: "playlist",
      tracks: [track("liked-seed"), track("disliked"), track("fresh")]
    } satisfies TrackLoadResult);
    const service = new AutoplayService({ load });

    const selected = await service.recommend({
      enabled: true,
      excludedTrackIds: new Set(["disliked"]),
      lastTrack: track("last"),
      preferredSeed: track("liked-seed"),
      queuedTrackIds: new Set(),
      recentTrackIds: new Set()
    });

    expect(load).toHaveBeenCalledWith(
      "https://www.youtube.com/watch?v=liked-seed&list=RDliked-seed",
      "autoplay",
      undefined
    );
    expect(selected?.identifier).toBe("fresh");
  });
});
