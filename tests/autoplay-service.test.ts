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
});

