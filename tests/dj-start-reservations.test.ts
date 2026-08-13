import { describe, expect, it } from "vitest";

import { DjStartReservations } from "../src/music/dj-start-reservations.js";

describe("DjStartReservations", () => {
  it("플레이리스트 조회 전에 만든 예약을 player 없이도 취소하고 정리 전까지 유지한다", () => {
    const starts = new DjStartReservations<object>();
    const reservation = starts.reserve("guild-1", "user-1");

    expect(starts.has("guild-1")).toBe(true);
    expect(starts.cancel("guild-1")).toBe(reservation);
    expect(reservation.cancelled).toBe(true);
    expect(starts.has("guild-1")).toBe(true);

    starts.release(reservation);
    expect(starts.has("guild-1")).toBe(false);
  });

  it("연결한 player 표시는 취소 뒤에도 outer cleanup이 release할 때까지 보존한다", () => {
    const starts = new DjStartReservations<{ id: string }>();
    const reservation = starts.reserve("guild-1", "user-1");
    const player = { id: "player-1" };

    expect(starts.attachPlayer(reservation, player)).toBe(true);
    starts.cancel("guild-1");

    expect(starts.get("guild-1")?.player).toBe(player);
    expect(starts.has("guild-1")).toBe(true);

    starts.release(reservation);
    expect(starts.get("guild-1")).toBeUndefined();
  });

  it("오래된 예약의 release가 같은 길드의 새 예약을 지우지 않는다", () => {
    const starts = new DjStartReservations<object>();
    const first = starts.reserve("guild-1", "user-1");
    starts.release(first);
    const second = starts.reserve("guild-1", "user-2");

    starts.release(first);

    expect(starts.get("guild-1")).toBe(second);
  });

  it("취소된 예약에는 뒤늦게 player를 연결하지 않는다", () => {
    const starts = new DjStartReservations<object>();
    const reservation = starts.reserve("guild-1", "user-1");
    starts.cancel("guild-1");

    expect(starts.attachPlayer(reservation, {})).toBe(false);
    expect(reservation.player).toBeUndefined();
  });
});
