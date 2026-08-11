import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GuildStateStore } from "../src/domain/guild-state.js";
import type { MusicTrack } from "../src/domain/types.js";
import { SqliteMusicRepository } from "../src/infrastructure/sqlite-music-repository.js";

function track(identifier: string, title = `track-${identifier}`): MusicTrack {
  return {
    artworkUrl: `https://example.com/${identifier}.jpg`,
    author: "artist",
    durationMs: 180_000,
    encoded: `encoded-${identifier}`,
    identifier,
    isSeekable: true,
    isStream: false,
    origin: "requested",
    requesterId: "user-1",
    sourceName: "youtube",
    title,
    uri: `https://youtube.com/watch?v=${identifier}`
  };
}

describe("SqliteMusicRepository", () => {
  let repository: SqliteMusicRepository;

  beforeEach(() => {
    repository = new SqliteMusicRepository(":memory:");
  });

  afterEach(() => {
    repository.close();
  });

  it("서버 설정을 저장하고 새 GuildStateStore에서 복구한다", () => {
    const firstStore = new GuildStateStore(repository);
    firstStore.updateSettings("guild-1", { autoplayDefault: false, defaultVolume: 65 });

    const restored = new GuildStateStore(repository).getOrCreate("guild-1");

    expect(restored).toMatchObject({
      autoplayDefault: false,
      autoplayEnabled: false,
      defaultVolume: 65
    });
  });

  it("개인 즐겨찾기는 같은 곡을 중복 저장하지 않고 사용자별로 격리한다", () => {
    expect(repository.addFavorite("user-1", track("a"))).toBe(true);
    expect(repository.addFavorite("user-1", track("a"))).toBe(false);
    repository.addFavorite("user-2", track("b"));

    expect(repository.listFavorites("user-1", 20).map(({ identifier }) => identifier)).toEqual([
      "a"
    ]);
    expect(repository.listFavorites("user-2", 20).map(({ identifier }) => identifier)).toEqual([
      "b"
    ]);
  });

  it("플레이리스트를 순서대로 저장하고 같은 이름은 원자적으로 교체한다", () => {
    expect(
      repository.savePlaylist("guild-1", "user-1", "출근길", [track("a"), track("b")])
    ).toBe("created");
    expect(
      repository.savePlaylist("guild-1", "user-1", "출근길", [track("c"), track("d")])
    ).toBe("replaced");

    expect(
      repository
        .getPlaylist("guild-1", "user-1", "출근길")
        ?.tracks.map(({ identifier }) => identifier)
    ).toEqual(["c", "d"]);
    expect(repository.listPlaylists("guild-1", "user-1")).toEqual([
      { name: "출근길", trackCount: 2 }
    ]);
  });

  it("플레이리스트는 서버와 사용자별로 격리되고 삭제할 수 있다", () => {
    repository.savePlaylist("guild-1", "user-1", "목록", [track("a")]);
    repository.savePlaylist("guild-2", "user-1", "목록", [track("b")]);
    repository.savePlaylist("guild-1", "user-2", "목록", [track("c")]);

    expect(repository.deletePlaylist("guild-1", "user-1", "목록")).toBe(true);
    expect(repository.getPlaylist("guild-1", "user-1", "목록")).toBeUndefined();
    expect(repository.getPlaylist("guild-2", "user-1", "목록")?.tracks[0]?.identifier).toBe("b");
    expect(repository.getPlaylist("guild-1", "user-2", "목록")?.tracks[0]?.identifier).toBe("c");
  });

  it("빈 이름·빈 목록·100곡 초과와 잘못된 조회 제한을 거부한다", () => {
    expect(() => repository.savePlaylist("guild-1", "user-1", " ", [track("a")])).toThrow(
      "이름"
    );
    expect(() => repository.savePlaylist("guild-1", "user-1", "빈 목록", [])).toThrow(
      "한 곡"
    );
    expect(() =>
      repository.savePlaylist(
        "guild-1",
        "user-1",
        "너무 큼",
        Array.from({ length: 101 }, (_, index) => track(String(index)))
      )
    ).toThrow("100곡");
    expect(() => repository.listFavorites("user-1", 0)).toThrow("조회 개수");
  });
});
