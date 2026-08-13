import { describe, expect, it, vi } from "vitest";

import { cleanupRemovedGuild } from "../src/discord/guild-removal.js";

function player() {
  return { destroy: vi.fn(async () => undefined) };
}

describe("cleanupRemovedGuild", () => {
  it("DJ 재생 정리를 먼저 끝내고 플레이어 메시지를 종료한다", async () => {
    const activePlayer = player();
    const calls: string[] = [];

    await cleanupRemovedGuild({
      activePlayer,
      closePlayback: async (received) => {
        expect(received).toBe(activePlayer);
        calls.push("playback");
      },
      finishPlayerMessage: async () => {
        calls.push("message");
      }
    });

    expect(calls).toEqual(["playback", "message"]);
    expect(activePlayer.destroy).not.toHaveBeenCalled();
  });

  it("시작 중 플레이어와 별도 활성 플레이어를 모두 정리한다", async () => {
    const activePlayer = player();
    const pendingPlayer = player();
    const closePlayback = vi.fn(async () => undefined);

    await cleanupRemovedGuild({
      activePlayer,
      closePlayback,
      finishPlayerMessage: async () => undefined,
      pendingPlayer
    });

    expect(closePlayback).toHaveBeenCalledWith(activePlayer);
    expect(pendingPlayer.destroy).toHaveBeenCalledWith("Discord 서버에서 봇이 제거됨");
  });

  it("한 정리가 실패해도 나머지를 시도한 뒤 오류를 반환한다", async () => {
    const pendingPlayer = player();
    const finishPlayerMessage = vi.fn(async () => undefined);

    await expect(cleanupRemovedGuild({
      closePlayback: async () => {
        throw new Error("engine cleanup failed");
      },
      finishPlayerMessage,
      pendingPlayer
    })).rejects.toThrow("engine cleanup failed");

    expect(finishPlayerMessage).toHaveBeenCalledOnce();
  });
});
