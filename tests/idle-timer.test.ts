import { afterEach, describe, expect, it, vi } from "vitest";

import { IdleTimerManager } from "../src/music/idle-timer.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("IdleTimerManager", () => {
  it("5분 후 정리 함수를 한 번 실행한다", async () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const timers = new IdleTimerManager(300_000);

    timers.schedule("guild-1", onExpire);
    await vi.advanceTimersByTimeAsync(300_000);

    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("같은 서버의 새 타이머는 기존 타이머를 교체한다", async () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    const timers = new IdleTimerManager(300_000);

    timers.schedule("guild-1", first);
    timers.schedule("guild-1", second);
    await vi.advanceTimersByTimeAsync(300_000);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("취소하면 정리 함수를 실행하지 않는다", async () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const timers = new IdleTimerManager(300_000);

    timers.schedule("guild-1", onExpire);
    timers.cancel("guild-1");
    await vi.advanceTimersByTimeAsync(300_000);

    expect(onExpire).not.toHaveBeenCalled();
  });

  it("cancelAll은 모든 서버의 유휴 타이머를 취소한다", async () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    const timers = new IdleTimerManager(300_000);

    timers.schedule("guild-1", first);
    timers.schedule("guild-2", second);
    timers.cancelAll();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });
});
