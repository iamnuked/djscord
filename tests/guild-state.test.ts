import { describe, expect, it } from "vitest";

import { GuildStateStore } from "../src/domain/guild-state.js";

describe("GuildStateStore", () => {
  it("새 서버는 자동재생이 켜진 상태로 시작한다", () => {
    const store = new GuildStateStore();

    expect(store.getOrCreate("guild-1").autoplayEnabled).toBe(true);
  });

  it("서버별 상태를 독립적으로 유지한다", () => {
    const store = new GuildStateStore();
    store.getOrCreate("guild-1").autoplayEnabled = false;

    expect(store.getOrCreate("guild-1").autoplayEnabled).toBe(false);
    expect(store.getOrCreate("guild-2").autoplayEnabled).toBe(true);
  });

  it("최근 재생곡은 최대 20개만 유지한다", () => {
    const store = new GuildStateStore();

    for (let index = 0; index < 25; index += 1) {
      store.rememberTrack("guild-1", `track-${index}`);
    }

    expect(store.getOrCreate("guild-1").recentTrackIds).toHaveLength(20);
    expect(store.getOrCreate("guild-1").recentTrackIds[0]).toBe("track-5");
  });
});
