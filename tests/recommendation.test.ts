import { describe, expect, it } from "vitest";

import { selectRecommendation } from "../src/domain/recommendation.js";
import type { MusicTrack } from "../src/domain/types.js";

function track(
  identifier: string,
  options: Partial<Pick<MusicTrack, "isStream" | "origin">> = {}
): MusicTrack {
  return {
    author: "artist",
    durationMs: 180_000,
    identifier,
    isSeekable: true,
    isStream: options.isStream ?? false,
    origin: options.origin ?? "requested",
    requesterId: "user-1",
    title: `track-${identifier}`,
    uri: `https://youtube.com/watch?v=${identifier}`
  };
}

describe("selectRecommendation", () => {
  it("현재 곡, 최근 곡, 대기열 곡을 제외하고 첫 후보를 고른다", () => {
    const selected = selectRecommendation({
      candidates: [track("current"), track("recent"), track("queued"), track("fresh")],
      currentIdentifier: "current",
      queuedIdentifiers: new Set(["queued"]),
      recentIdentifiers: new Set(["recent"])
    });

    expect(selected?.identifier).toBe("fresh");
    expect(selected?.origin).toBe("recommended");
    expect(selected?.requesterId).toBeUndefined();
  });

  it("라이브 스트림을 제외한다", () => {
    const selected = selectRecommendation({
      candidates: [track("live", { isStream: true }), track("regular")],
      currentIdentifier: "seed",
      queuedIdentifiers: new Set(),
      recentIdentifiers: new Set()
    });

    expect(selected?.identifier).toBe("regular");
  });

  it("유효 후보가 없으면 undefined를 반환한다", () => {
    const selected = selectRecommendation({
      candidates: [track("recent"), track("live", { isStream: true })],
      currentIdentifier: "seed",
      queuedIdentifiers: new Set(),
      recentIdentifiers: new Set(["recent"])
    });

    expect(selected).toBeUndefined();
  });
});

