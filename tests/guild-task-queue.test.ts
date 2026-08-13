import { describe, expect, it, vi } from "vitest";

import { GuildTaskQueue } from "../src/music/guild-task-queue.js";

describe("GuildTaskQueue", () => {
  it("같은 서버의 작업을 호출 순서대로 직렬 실행한다", async () => {
    const queue = new GuildTaskQueue();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = queue.run("guild-1", async () => {
      order.push("first-start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first-end");
    });
    const second = queue.run("guild-1", () => {
      order.push("second");
    });

    await vi.waitFor(() => expect(order).toEqual(["first-start"]));
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("서로 다른 서버의 작업은 서로 막지 않는다", async () => {
    const queue = new GuildTaskQueue();
    const secondGuild = vi.fn();
    let releaseFirst: (() => void) | undefined;

    const first = queue.run("guild-1", () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      })
    );
    await queue.run("guild-2", secondGuild);

    expect(secondGuild).toHaveBeenCalledOnce();
    releaseFirst?.();
    await first;
  });

  it("실패한 작업이 다음 작업을 막지 않는다", async () => {
    const queue = new GuildTaskQueue();

    await expect(
      queue.run("guild-1", () => {
        throw new Error("failure");
      })
    ).rejects.toThrow("failure");

    await expect(queue.run("guild-1", () => "recovered")).resolves.toBe("recovered");
  });

  it("close는 새 작업을 거절하고 이미 실행 중인 작업이 끝날 때까지 기다린다", async () => {
    const queue = new GuildTaskQueue();
    let release: (() => void) | undefined;
    const running = queue.run("guild-1", () => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const draining = queue.close();

    await expect(queue.run("guild-1", () => undefined)).rejects.toThrow(/종료/u);
    let drained = false;
    void draining.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    release?.();
    await Promise.all([running, draining]);
    expect(drained).toBe(true);
  });
});
