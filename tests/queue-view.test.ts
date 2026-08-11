import { describe, expect, it } from "vitest";

import { formatQueue } from "../src/discord/queue-view.js";
import type { MusicTrack } from "../src/domain/types.js";

function track(identifier: string, origin: MusicTrack["origin"]): MusicTrack {
  return {
    author: "artist",
    durationMs: 65_000,
    identifier,
    isSeekable: true,
    isStream: false,
    origin,
    title: `track-${identifier}`,
    uri: `https://youtube.com/watch?v=${identifier}`
  };
}

describe("formatQueue", () => {
  it("빈 대기열을 안내한다", () => {
    expect(formatQueue(null, [])).toBe("현재 재생 중인 곡이 없습니다.");
  });

  it("현재 곡과 다음 10곡, 남은 곡 수를 표시한다", () => {
    const upcoming = Array.from({ length: 12 }, (_, index) =>
      track(String(index), index === 0 ? "recommended" : "requested")
    );

    const output = formatQueue(track("now", "requested"), upcoming);

    expect(output).toContain("현재: track-now · artist · 1:05 · 요청");
    expect(output).toContain("1. track-0 · artist · 1:05 · 추천");
    expect(output).toContain("그 외 2곡");
    expect(output).not.toContain("track-10");
  });
});

