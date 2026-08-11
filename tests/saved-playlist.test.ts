import { describe, expect, it } from "vitest";

import type { MusicTrack } from "../src/domain/types.js";
import { restoreSavedTracks } from "../src/music/saved-playlist.js";
import type { TrackLoader, TrackLoadResult } from "../src/music/ports.js";

function track(identifier: string): MusicTrack {
  return {
    author: "artist",
    durationMs: 180_000,
    encoded: `encoded-${identifier}`,
    identifier,
    isSeekable: true,
    isStream: false,
    origin: "requested",
    requesterId: "old-user",
    sourceName: "youtube",
    title: `track-${identifier}`,
    uri: `https://youtube.com/watch?v=${identifier}`
  };
}

class FakeLoader implements TrackLoader {
  readonly queries: string[] = [];

  constructor(private readonly results: Map<string, TrackLoadResult>) {}

  async load(query: string): Promise<TrackLoadResult> {
    this.queries.push(query);
    return this.results.get(query) ?? { loadType: "empty", tracks: [] };
  }
}

describe("restoreSavedTracks", () => {
  it("저장된 URL을 다시 조회해 순서와 새 요청자를 보존한다", async () => {
    const saved = [track("a"), track("b")];
    const loader = new FakeLoader(
      new Map(saved.map((item) => [item.uri, { loadType: "track", tracks: [item] }]))
    );

    const restored = await restoreSavedTracks(loader, saved, "new-user");

    expect(loader.queries).toEqual(saved.map(({ uri }) => uri));
    expect(restored.tracks.map(({ identifier }) => identifier)).toEqual(["a", "b"]);
    expect(restored.tracks.every(({ origin }) => origin === "requested")).toBe(true);
    expect(restored.tracks.every(({ requesterId }) => requesterId === "new-user")).toBe(true);
    expect(restored.unavailableCount).toBe(0);
  });

  it("삭제된 곡은 건너뛰고 나머지 곡은 계속 복구한다", async () => {
    const saved = [track("a"), track("missing"), track("b")];
    const loader = new FakeLoader(
      new Map([
        [saved[0]!.uri, { loadType: "track", tracks: [saved[0]!] }],
        [saved[2]!.uri, { loadType: "track", tracks: [saved[2]!] }]
      ])
    );

    const restored = await restoreSavedTracks(loader, saved, "user-1");

    expect(restored.tracks.map(({ identifier }) => identifier)).toEqual(["a", "b"]);
    expect(restored.unavailableCount).toBe(1);
  });
});
