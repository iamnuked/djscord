import { describe, expect, it, vi } from "vitest";

import type { MusicTrack } from "../src/domain/types.js";
import {
  PlayerMessageController,
  type EditablePlayerMessage,
  type PlayerMessagePayload
} from "../src/discord/player-message-controller.js";
import type { PlayerCardSnapshot } from "../src/discord/player-view.js";

function track(identifier: string): MusicTrack {
  return {
    author: "artist",
    durationMs: 180_000,
    encoded: `encoded-${identifier}`,
    identifier,
    isSeekable: true,
    isStream: false,
    origin: "requested",
    requesterId: "user-1",
    sourceName: "youtube",
    title: `track-${identifier}`,
    uri: `https://youtube.com/watch?v=${identifier}`
  };
}

function snapshot(identifier: string, status: PlayerCardSnapshot["status"]): PlayerCardSnapshot {
  return {
    autoplayEnabled: true,
    current: status === "ended" ? null : track(identifier),
    next: null,
    positionMs: 0,
    queueSize: 0,
    status,
    updatedAt: new Date("2026-08-11T12:00:00Z")
  };
}

describe("PlayerMessageController", () => {
  it("한 세션에서 메시지를 한 번만 만들고 이후에는 같은 메시지를 편집한다", async () => {
    let current = snapshot("one", "playing");
    const edit = vi.fn<EditablePlayerMessage["edit"]>().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue({ edit, id: "message-1" });
    const controller = new PlayerMessageController({
      idFactory: () => "session-1",
      send,
      snapshotProvider: () => current
    });

    await controller.refresh("guild-1", "channel-1");
    current = snapshot("two", "paused");
    await controller.refresh("guild-1", "other-channel");

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("channel-1", expect.any(Object));
    expect(edit).toHaveBeenCalledOnce();
    expect(controller.isCurrent("guild-1", "session-1", "message-1")).toBe(true);
  });

  it("메시지 편집이 실패하면 같은 채널에 새 메시지를 만든다", async () => {
    const edit = vi.fn<EditablePlayerMessage["edit"]>().mockRejectedValue(new Error("Unknown Message"));
    const replacementEdit = vi.fn<EditablePlayerMessage["edit"]>().mockResolvedValue(undefined);
    const send = vi
      .fn()
      .mockResolvedValueOnce({ edit, id: "message-1" })
      .mockResolvedValueOnce({ edit: replacementEdit, id: "message-2" });
    const controller = new PlayerMessageController({
      idFactory: () => "session-1",
      send,
      snapshotProvider: () => snapshot("one", "playing")
    });

    await controller.refresh("guild-1", "channel-1");
    await controller.refresh("guild-1", "channel-2");

    expect(send).toHaveBeenNthCalledWith(2, "channel-1", expect.any(Object));
    expect(controller.isCurrent("guild-1", "session-1", "message-2")).toBe(true);
  });

  it("편집을 직렬화하고 마지막 작업에서 최신 상태를 다시 읽는다", async () => {
    let current = snapshot("one", "playing");
    let releaseEdit: (() => void) | undefined;
    const payloads: PlayerMessagePayload[] = [];
    const edit = vi.fn<EditablePlayerMessage["edit"]>().mockImplementation((payload) => {
      payloads.push(payload);
      if (payloads.length === 1) {
        return new Promise<void>((resolve) => {
          releaseEdit = resolve;
        });
      }
      return Promise.resolve();
    });
    const controller = new PlayerMessageController({
      idFactory: () => "session-1",
      send: vi.fn().mockResolvedValue({ edit, id: "message-1" }),
      snapshotProvider: () => current
    });
    await controller.refresh("guild-1", "channel-1");

    current = snapshot("two", "paused");
    const first = controller.refresh("guild-1", "channel-1");
    await vi.waitFor(() => expect(edit).toHaveBeenCalledTimes(1));
    current = snapshot("three", "playing");
    const second = controller.refresh("guild-1", "channel-1");
    releaseEdit?.();
    await Promise.all([first, second]);

    expect(payloads.at(-1)?.embeds[0]?.toJSON().title).toBe("track-three");
  });

  it("종료 시 버튼을 비활성화하고 기존 세션을 만료시킨다", async () => {
    const edit = vi.fn<EditablePlayerMessage["edit"]>().mockResolvedValue(undefined);
    const controller = new PlayerMessageController({
      idFactory: () => "session-1",
      send: vi.fn().mockResolvedValue({ edit, id: "message-1" }),
      snapshotProvider: () => snapshot("one", "playing")
    });
    await controller.refresh("guild-1", "channel-1");

    await controller.finish("guild-1");

    expect(controller.isCurrent("guild-1", "session-1", "message-1")).toBe(false);
    expect(
      edit.mock.calls.at(-1)?.[0].components
        .flatMap((row) => row.toJSON().components)
        .every(({ disabled }) => disabled)
    ).toBe(true);
  });

  it("서버별 새로고침을 5초로 제한한다", () => {
    const controller = new PlayerMessageController({
      idFactory: () => "session-1",
      send: vi.fn(),
      snapshotProvider: () => snapshot("one", "playing")
    });

    expect(controller.tryRefresh("guild-1", 1_000)).toBe(true);
    expect(controller.tryRefresh("guild-1", 5_999)).toBe(false);
    expect(controller.tryRefresh("guild-1", 6_000)).toBe(true);
  });
});
