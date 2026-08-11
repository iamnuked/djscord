import { describe, expect, it, vi } from "vitest";

import { TrackResolverService } from "../src/music/track-resolver.js";
import type { MusicTrack } from "../src/domain/types.js";
import type { TrackLoadResult, TrackLoader } from "../src/music/ports.js";

function track(identifier: string): MusicTrack {
  return {
    author: "artist",
    durationMs: 180_000,
    identifier,
    isSeekable: true,
    isStream: false,
    origin: "requested",
    requesterId: "user-1",
    title: `track-${identifier}`,
    uri: `https://youtube.com/watch?v=${identifier}`
  };
}

function result(
  tracks: MusicTrack[],
  loadType: TrackLoadResult["loadType"] = "search",
  unavailableCount = 0
) {
  return { loadType, tracks, unavailableCount } satisfies TrackLoadResult;
}

describe("TrackResolverService", () => {
  it("검색어는 YouTube Music을 먼저 사용하고 상위 5개를 반환한다", async () => {
    const load = vi.fn<TrackLoader["load"]>().mockResolvedValue(
      result(Array.from({ length: 8 }, (_, index) => track(String(index))))
    );
    const resolver = new TrackResolverService({ load });

    const resolved = await resolver.resolve("아이유 좋은 날", "user-1");

    expect(load).toHaveBeenCalledWith("아이유 좋은 날", "user-1", "ytmsearch");
    expect(resolved.kind).toBe("selection");
    expect(resolved.tracks).toHaveLength(5);
    expect(resolved.skipped).toBe(0);
  });

  it("YouTube Music 결과가 없으면 일반 YouTube로 폴백한다", async () => {
    const load = vi
      .fn<TrackLoader["load"]>()
      .mockResolvedValueOnce(result([], "empty"))
      .mockResolvedValueOnce(result([track("fallback")]));
    const resolver = new TrackResolverService({ load });

    const resolved = await resolver.resolve("검색어", "user-1");

    expect(load).toHaveBeenNthCalledWith(1, "검색어", "user-1", "ytmsearch");
    expect(load).toHaveBeenNthCalledWith(2, "검색어", "user-1", "ytsearch");
    expect(resolved.tracks[0]?.identifier).toBe("fallback");
  });

  it("영상 URL은 선택 과정 없이 단일 곡을 반환한다", async () => {
    const load = vi.fn<TrackLoader["load"]>().mockResolvedValue(result([track("video")], "track"));
    const resolver = new TrackResolverService({ load });

    const resolved = await resolver.resolve(
      "https://www.youtube.com/watch?v=video",
      "user-1"
    );

    expect(load).toHaveBeenCalledWith(
      "https://www.youtube.com/watch?v=video",
      "user-1",
      undefined
    );
    expect(resolved.kind).toBe("tracks");
    expect(resolved.tracks).toHaveLength(1);
  });

  it("재생목록은 50곡으로 자르고 생략 수를 반환한다", async () => {
    const load = vi.fn<TrackLoader["load"]>().mockResolvedValue(
      result(Array.from({ length: 60 }, (_, index) => track(String(index))), "playlist", 2)
    );
    const resolver = new TrackResolverService({ load });

    const resolved = await resolver.resolve(
      "https://www.youtube.com/playlist?list=PL123",
      "user-1"
    );

    expect(resolved.kind).toBe("tracks");
    expect(resolved.tracks).toHaveLength(50);
    expect(resolved.skipped).toBe(10);
    expect(resolved.unavailable).toBe(2);
  });

  it("검색 결과가 없으면 사용자용 오류를 던진다", async () => {
    const load = vi.fn<TrackLoader["load"]>().mockResolvedValue(result([], "empty"));
    const resolver = new TrackResolverService({ load });

    await expect(resolver.resolve("없는 노래", "user-1")).rejects.toThrow(
      "검색 결과를 찾지 못했습니다."
    );
  });
});
