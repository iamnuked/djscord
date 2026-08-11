import { describe, expect, it } from "vitest";

import { addRequestedTracks } from "../src/domain/queue.js";
import type { MusicTrack } from "../src/domain/types.js";

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

describe("addRequestedTracks", () => {
  it("재생목록은 50곡까지만 대기열에 추가한다", () => {
    const incoming = Array.from({ length: 70 }, (_, index) => track(String(index)));

    const result = addRequestedTracks([], incoming, { perRequestLimit: 50, queueLimit: 100 });

    expect(result.queue).toHaveLength(50);
    expect(result.added).toBe(50);
    expect(result.skipped).toBe(20);
  });

  it("기존 대기열을 포함해 100곡을 넘지 않는다", () => {
    const existing = Array.from({ length: 90 }, (_, index) => track(`old-${index}`));
    const incoming = Array.from({ length: 20 }, (_, index) => track(`new-${index}`));

    const result = addRequestedTracks(existing, incoming, {
      perRequestLimit: 50,
      queueLimit: 100
    });

    expect(result.queue).toHaveLength(100);
    expect(result.added).toBe(10);
    expect(result.skipped).toBe(10);
  });

  it("중복 곡을 허용한다", () => {
    const duplicate = track("same");

    const result = addRequestedTracks([duplicate], [duplicate], {
      perRequestLimit: 50,
      queueLimit: 100
    });

    expect(result.queue).toHaveLength(2);
    expect(result.added).toBe(1);
  });
});

