import { afterEach, describe, expect, it, vi } from "vitest";

import { GuildRegistrySynchronizer } from "../src/music/guild-registry-synchronizer.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("GuildRegistrySynchronizer", () => {
  it("첫 업로드 실패 뒤 별도 guild 이벤트가 없어도 주기적으로 복구한다", async () => {
    vi.useFakeTimers();
    const sync = vi.fn()
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const synchronizer = new GuildRegistrySynchronizer({
      intervalMs: 1_000,
      onError,
      sync
    });

    synchronizer.start();
    await synchronizer.trigger();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sync).toHaveBeenCalledTimes(2);
    await synchronizer.stop();
  });

  it("겹친 요청을 직렬화하고 stop 뒤에는 추가 업로드를 만들지 않는다", async () => {
    let release: (() => void) | undefined;
    const sync = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const synchronizer = new GuildRegistrySynchronizer({
      intervalMs: 60_000,
      onError: vi.fn(),
      sync
    });

    const first = synchronizer.trigger();
    const second = synchronizer.trigger();
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    release?.();
    await first;
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
    release?.();
    await second;
    await synchronizer.stop();
    await synchronizer.trigger();

    expect(sync).toHaveBeenCalledTimes(2);
  });
});
