import { describe, expect, it } from "vitest";

import type { MusicTrack } from "../src/domain/types.js";
import { GenreDraftStore } from "../src/discord/genre-draft.js";

function track(identifier: string): MusicTrack {
  return {
    author: "artist",
    durationMs: 180_000,
    encoded: `encoded-${identifier}`,
    identifier,
    isSeekable: true,
    isStream: false,
    origin: "genre",
    requesterId: "user-1",
    sourceName: "youtube",
    title: `track-${identifier}`,
    uri: `https://youtube.com/watch?v=${identifier}`
  };
}

describe("GenreDraftStore", () => {
  it("같은 서버와 사용자의 새 Draft가 기존 Draft를 교체한다", () => {
    const store = new GenreDraftStore<string>({ idFactory: () => "draft-id", ttlMs: 600_000 });
    const first = store.create({
      context: "first-loader",
      guildId: "guild-1",
      now: 0,
      tracks: [track("one")],
      userId: "user-1"
    });
    const second = store.create({
      context: "second-loader",
      guildId: "guild-1",
      now: 1,
      tracks: [track("two")],
      userId: "user-1"
    });

    expect(second.replaced?.id).toBe(first.draft.id);
    expect(second.draft.context).toBe("second-loader");
  });

  it("페이지별 선택을 유지하고 제거 버튼에서 선택된 곡을 영구 제거한다", () => {
    let nextId = 0;
    const store = new GenreDraftStore({
      idFactory: () => `draft-${nextId += 1}`,
      ttlMs: 600_000
    });
    const { draft } = store.create({
      context: {},
      guildId: "guild-1",
      now: 0,
      tracks: Array.from({ length: 15 }, (_, index) => track(String(index))),
      userId: "user-1"
    });

    const selectedFirstPage = store.setSelection(draft, ["1", "2"], 1);
    const secondPage = store.setPage(selectedFirstPage, 1, 2);
    const selectedSecondPage = store.setSelection(secondPage, ["11"], 3);
    const removed = store.removeSelected(selectedSecondPage, 4);

    expect(removed.tracks.map(({ identifier }) => identifier)).not.toEqual(
      expect.arrayContaining(["1", "2", "11"])
    );
    expect(removed.selectedTrackIds.size).toBe(0);
  });

  it("마지막 페이지의 곡을 제거하면 현재 페이지를 유효한 범위로 보정한다", () => {
    const store = new GenreDraftStore({ idFactory: () => "draft", ttlMs: 600_000 });
    const { draft } = store.create({
      context: {},
      guildId: "guild-1",
      now: 0,
      tracks: Array.from({ length: 11 }, (_, index) => track(String(index))),
      userId: "user-1"
    });

    const page = store.setPage(draft, 1, 1);
    const selected = store.setSelection(page, ["10"], 2);
    const removed = store.removeSelected(selected, 3);

    expect(removed.page).toBe(0);
    expect(removed.tracks).toHaveLength(10);
  });

  it("이전 revision, 다른 사용자, 만료된 Draft 접근을 거부한다", () => {
    const store = new GenreDraftStore({ idFactory: () => "draft", ttlMs: 600_000 });
    const { draft } = store.create({
      context: {},
      guildId: "guild-1",
      now: 0,
      tracks: [track("one")],
      userId: "user-1"
    });
    const updated = store.setSelection(draft, ["one"], 1);

    expect(store.find("guild-1", "user-1", draft.id, draft.revision, 2)).toBeUndefined();
    expect(store.find("guild-1", "other", updated.id, updated.revision, 2)).toBeUndefined();
    expect(store.find("guild-1", "user-1", updated.id, updated.revision, 600_001)).toBeUndefined();
  });

  it("확정은 Draft를 한 번만 소비하고 취소는 아무 곡도 반환하지 않는다", () => {
    let nextId = 0;
    const store = new GenreDraftStore({
      idFactory: () => `draft-${nextId += 1}`,
      ttlMs: 600_000
    });
    const { draft } = store.create({
      context: {},
      guildId: "guild-1",
      now: 0,
      tracks: [track("one")],
      userId: "user-1"
    });

    expect(store.consume(draft, 1)?.tracks).toHaveLength(1);
    expect(store.consume(draft, 2)).toBeUndefined();

    const { draft: cancelled } = store.create({
      context: {},
      guildId: "guild-1",
      now: 3,
      tracks: [track("two")],
      userId: "user-1"
    });
    store.cancel(cancelled);
    expect(store.consume(cancelled, 4)).toBeUndefined();
  });
});
