import { describe, expect, it, vi } from "vitest";

import type { MusicTrack } from "../src/domain/types.js";
import { GenrePlaylistService } from "../src/music/genre-playlist.js";
import type { TrackLoadResult, TrackLoader } from "../src/music/ports.js";

function track(
  identifier: string,
  options: Partial<Pick<MusicTrack, "isStream" | "sourceName">> = {}
): MusicTrack {
  return {
    author: "artist",
    durationMs: 180_000,
    encoded: `encoded-${identifier}`,
    identifier,
    isSeekable: true,
    isStream: options.isStream ?? false,
    origin: "requested",
    requesterId: "user-1",
    sourceName: options.sourceName ?? "youtube",
    title: `track-${identifier}`,
    uri: `https://youtube.com/watch?v=${identifier}`
  };
}

function result(tracks: MusicTrack[], loadType: TrackLoadResult["loadType"] = "search") {
  return { loadType, tracks } satisfies TrackLoadResult;
}

describe("GenrePlaylistService", () => {
  it("대표곡, Mix, 나머지 검색 결과 순으로 후보를 만들고 반복 곡을 제외한다", async () => {
    const load = vi
      .fn<TrackLoader["load"]>()
      .mockResolvedValueOnce(
        result([
          track("seed"),
          track("search-2"),
          track("queued"),
          track("live", { isStream: true })
        ])
      )
      .mockResolvedValueOnce(
        result(
          [
            track("seed"),
            track("mix-1"),
            track("recent"),
            track("mix-2"),
            track("other-source", { sourceName: "soundcloud" })
          ],
          "playlist"
        )
      );
    const service = new GenrePlaylistService({ load });

    const generated = await service.generate({
      count: 5,
      excludedTrackIds: new Set(["queued", "recent"]),
      genre: "재즈",
      requesterId: "user-1"
    });

    expect(load).toHaveBeenNthCalledWith(1, "재즈 음악", "user-1", "ytmsearch");
    expect(load).toHaveBeenNthCalledWith(
      2,
      "https://www.youtube.com/watch?v=seed&list=RDseed",
      "user-1",
      undefined
    );
    expect(generated.tracks.map(({ identifier }) => identifier)).toEqual([
      "seed",
      "mix-1",
      "mix-2",
      "search-2"
    ]);
    expect(generated.tracks.every(({ origin }) => origin === "genre")).toBe(true);
    expect(generated.missingCount).toBe(1);
  });

  it("YouTube Music의 재생 가능한 결과가 없으면 일반 YouTube 검색으로 폴백한다", async () => {
    const load = vi
      .fn<TrackLoader["load"]>()
      .mockResolvedValueOnce(result([track("live", { isStream: true })]))
      .mockResolvedValueOnce(result([track("fallback"), track("second")]))
      .mockRejectedValueOnce(new Error("mix unavailable"));
    const service = new GenrePlaylistService({ load });

    const generated = await service.generate({
      count: 5,
      excludedTrackIds: new Set(),
      genre: "rock",
      requesterId: "user-1"
    });

    expect(load).toHaveBeenNthCalledWith(2, "rock music", "user-1", "ytsearch");
    expect(generated.tracks.map(({ identifier }) => identifier)).toEqual([
      "fallback",
      "second"
    ]);
    expect(generated.missingCount).toBe(3);
  });

  it("후보 내부의 YouTube ID 중복을 제거하고 요청한 수만 반환한다", async () => {
    const load = vi
      .fn<TrackLoader["load"]>()
      .mockResolvedValueOnce(
        result(Array.from({ length: 8 }, (_, index) => track(`track-${index}`)))
      )
      .mockResolvedValueOnce(result([track("track-0"), track("track-1")], "playlist"));
    const service = new GenrePlaylistService({ load });

    const generated = await service.generate({
      count: 5,
      excludedTrackIds: new Set(),
      genre: "pop",
      requesterId: "user-1"
    });

    expect(generated.tracks).toHaveLength(5);
    expect(new Set(generated.tracks.map(({ identifier }) => identifier)).size).toBe(5);
    expect(generated.missingCount).toBe(0);
  });

  it("곡수 범위와 검색 결과 없음 오류를 검증한다", async () => {
    const load = vi.fn<TrackLoader["load"]>().mockResolvedValue(result([], "empty"));
    const service = new GenrePlaylistService({ load });

    await expect(
      service.generate({
        count: 4,
        excludedTrackIds: new Set(),
        genre: "jazz",
        requesterId: "user-1"
      })
    ).rejects.toThrow("5곡에서 30곡");
    await expect(
      service.generate({
        count: 5,
        excludedTrackIds: new Set(),
        genre: "unknown",
        requesterId: "user-1"
      })
    ).rejects.toThrow("장르에 맞는 곡을 찾지 못했습니다");
  });
});
