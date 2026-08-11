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
  it("등록되지 않은 장르는 Last.fm 상위 아티스트를 여러 YouTube Mix 시드로 사용한다", async () => {
    const getTopArtists = vi.fn().mockResolvedValue(["Miles Davis", "John Coltrane"]);
    const load = vi.fn<TrackLoader["load"]>(async (query, _requesterId, source) => {
      if (source !== undefined) {
        const artist = query.replace(" official music video", "");
        return result([
          {
            ...track(`${artist.toLocaleLowerCase("en-US").replaceAll(" ", "-")}-seed`),
            author: artist,
            title: `${artist} official video`
          }
        ]);
      }

      const seedId = new URL(query).searchParams.get("v");
      return result(
        seedId === null
          ? []
          : [track(seedId), track(`${seedId}-mix-1`), track(`${seedId}-mix-2`)],
        "playlist"
      );
    });
    const service = new GenrePlaylistService({ load }, { getTopArtists });

    const generated = await service.generate({
      count: 5,
      excludedTrackIds: new Set(),
      genre: "재즈",
      requesterId: "user-1"
    });

    expect(getTopArtists).toHaveBeenCalledWith("jazz", 6);
    expect(generated.source).toBe("lastfm");
    expect(generated.tracks.map(({ identifier }) => identifier)).toEqual([
      "miles-davis-seed",
      "john-coltrane-seed",
      "miles-davis-seed-mix-1",
      "john-coltrane-seed-mix-1",
      "miles-davis-seed-mix-2"
    ]);
  });

  it("Last.fm 조회가 실패하면 기존 YouTube 장르 검색으로 폴백한다", async () => {
    const getTopArtists = vi.fn().mockRejectedValue(new Error("rate limited"));
    const load = vi
      .fn<TrackLoader["load"]>()
      .mockResolvedValueOnce(result([track("youtube-seed"), track("youtube-search-2")]))
      .mockResolvedValueOnce(result([track("youtube-seed"), track("youtube-mix")], "playlist"));
    const service = new GenrePlaylistService({ load }, { getTopArtists });

    const generated = await service.generate({
      count: 5,
      excludedTrackIds: new Set(),
      genre: "rock",
      requesterId: "user-1"
    });

    expect(generated.source).toBe("youtube");
    expect(generated.tracks.map(({ identifier }) => identifier)).toEqual([
      "youtube-seed",
      "youtube-mix",
      "youtube-search-2"
    ]);
  });

  it("K-pop 대표 아티스트의 유효한 시드를 찾고 각 Mix를 라운드 로빈으로 합친다", async () => {
    const seedResults = new Map<string, MusicTrack[]>([
      ["BTS official music video", [track("wrong-bts"), track("bts-seed")]],
      ["BLACKPINK official music video", [track("wrong-blackpink"), track("blackpink-seed")]],
      ["aespa official music video", [track("wrong-aespa"), track("aespa-seed")]],
      ["IVE official music video", [track("wrong-ive"), track("ive-seed")]],
      ["Stray Kids official music video", [track("wrong-skz"), track("skz-seed")]],
      ["NewJeans official music video", [track("wrong-newjeans"), track("newjeans-seed")]]
    ]);
    const seedMetadata = new Map<string, { author: string; title: string }>([
      ["bts-seed", { author: "BTS", title: "BTS official MV" }],
      ["blackpink-seed", { author: "BLACKPINK", title: "BLACKPINK official MV" }],
      ["aespa-seed", { author: "aespa", title: "aespa official MV" }],
      ["ive-seed", { author: "IVE", title: "IVE official MV" }],
      ["skz-seed", { author: "Stray Kids", title: "Stray Kids official MV" }],
      ["newjeans-seed", { author: "NewJeans", title: "NewJeans official MV" }]
    ]);
    for (const tracks of seedResults.values()) {
      for (const candidate of tracks) {
        const metadata = seedMetadata.get(candidate.identifier);
        if (metadata !== undefined) {
          Object.assign(candidate, metadata);
        } else {
          Object.assign(candidate, { author: "unrelated artist", title: "unrelated official MV" });
        }
      }
    }

    const load = vi.fn<TrackLoader["load"]>(async (query, _requesterId, source) => {
      if (source === "ytmsearch") {
        return result(seedResults.get(query) ?? []);
      }

      const seedId = new URL(query).searchParams.get("v");
      return result(
        seedId === null
          ? []
          : [track(seedId), track(`${seedId}-mix-1`), track(`${seedId}-mix-2`)],
        "playlist"
      );
    });
    const service = new GenrePlaylistService({ load });

    const generated = await service.generate({
      count: 10,
      excludedTrackIds: new Set(),
      genre: "케이팝",
      requesterId: "user-1"
    });

    expect(generated.tracks.map(({ identifier }) => identifier)).toEqual([
      "bts-seed",
      "blackpink-seed",
      "aespa-seed",
      "ive-seed",
      "skz-seed",
      "newjeans-seed",
      "bts-seed-mix-1",
      "blackpink-seed-mix-1",
      "aespa-seed-mix-1",
      "ive-seed-mix-1"
    ]);
    expect(load).not.toHaveBeenCalledWith("케이팝 음악", "user-1", "ytmsearch");
    expect(generated.missingCount).toBe(0);
  });

  it("private 상태를 사용하는 실제 Loader의 메서드 바인딩을 유지한다", async () => {
    class StatefulLoader implements TrackLoader {
      readonly #results = [
        result([track("seed"), track("search-2")]),
        result([track("seed"), track("mix-1")], "playlist")
      ];
      #index = 0;

      async load(): Promise<TrackLoadResult> {
        const loaded = this.#results[this.#index];
        this.#index += 1;
        return loaded ?? result([], "empty");
      }
    }

    const service = new GenrePlaylistService(new StatefulLoader());

    const generated = await service.generate({
      count: 5,
      excludedTrackIds: new Set(),
      genre: "재즈",
      requesterId: "user-1"
    });

    expect(generated.tracks.map(({ identifier }) => identifier)).toEqual([
      "seed",
      "mix-1",
      "search-2"
    ]);
  });

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
