import type { SearchResult, Track } from "lavalink-client";
import { describe, expect, it, vi } from "vitest";

import { DjPlaybackService } from "../src/music/dj-playback-service.js";

const AUDIO_URL =
  "http://djengine:8787/api/v1/sessions/session-1/audio.ogg?token=super-secret-token";

interface TestSession {
  id: string;
  playlistId: string;
  ownerRef: string;
  status: "preparing" | "ready";
  currentTrackId: string | null;
  createdAt: string;
  audioUrl: string;
  energyProfile: "peak";
}

function session(overrides: Partial<TestSession> = {}): TestSession {
  return {
    audioUrl: AUDIO_URL,
    createdAt: "2026-08-13T00:00:00Z",
    currentTrackId: null,
    energyProfile: "peak",
    id: "session-1",
    ownerRef: "guild-1",
    playlistId: "playlist-1",
    status: "preparing",
    ...overrides
  };
}

function rawDjTrack(uri = AUDIO_URL): Track {
  return {
    encoded: "encoded-dj-stream",
    info: {
      artworkUrl: null,
      author: "Unknown artist",
      duration: 0,
      identifier: "djengine-http-stream",
      isSeekable: false,
      isStream: true,
      isrc: null,
      sourceName: "http",
      title: "Unknown title",
      uri
    },
    pluginInfo: {},
    requester: { id: "user-1" }
  };
}

function searchResult(tracks: Track[]): SearchResult {
  return {
    exception: null,
    loadType: tracks.length === 0 ? "empty" : "track",
    playlist: null,
    pluginInfo: {},
    tracks
  };
}

function createEngine() {
  const created = session();
  return {
    closeSession: vi.fn(async (_sessionId: string) => undefined),
    createSession: vi.fn(async (_input: unknown) => created),
    listPlaylists: vi.fn(async () => ({
      data: [{ id: "playlist-1", name: "Friday Mix", path: "ROOT/Friday Mix" }],
      meta: { hasNext: false, nextCursor: null }
    })),
    sendCommand: vi.fn(
      async (
        _sessionId: string,
        commandId: string,
        command: { type: "pause" | "play" | "skip" },
        quantize: "immediate" | "next_beat" | "next_bar" | "next_phrase" = "next_bar"
      ) => ({ commandId, quantize, scheduledSample: 0, ...command })
    ),
    waitUntilReady: vi.fn(async (_sessionId: string) => ({
      ...created,
      audioUrl: undefined,
      energyProfile: undefined,
      status: "ready" as const
    }))
  };
}

function createPlayer(track = rawDjTrack()) {
  return {
    destroy: vi.fn(async (_reason: string) => undefined),
    pause: vi.fn(async () => undefined),
    play: vi.fn(async () => undefined),
    queue: { add: vi.fn(async (_track: Track) => undefined) },
    resume: vi.fn(async () => undefined),
    search: vi.fn(async (_query: string, _requester: { id: string }, _throwOnEmpty?: boolean) =>
      searchResult([track])
    ),
    skip: vi.fn(async () => undefined),
    stopPlaying: vi.fn(async (_clearQueue?: boolean, _executeAutoplay?: boolean) => undefined)
  };
}

function startInput(player: ReturnType<typeof createPlayer>, guildId = "guild-1") {
  return {
    energyProfile: "peak" as const,
    guildId,
    idempotencyKey: `attempt-${guildId}`,
    maxDurationMinutes: 45,
    ownerRef: guildId,
    player,
    playlistId: "playlist-1",
    playlistName: "Friday Mix",
    requesterId: "user-1"
  };
}

describe("DjPlaybackService", () => {
  it("DJ Engine 플레이리스트 목록을 그대로 제공한다", async () => {
    const engine = createEngine();
    const service = new DjPlaybackService(engine);

    const result = await service.listPlaylists();

    expect(result).toEqual({
      data: [{ id: "playlist-1", name: "Friday Mix", path: "ROOT/Friday Mix" }],
      meta: { hasNext: false, nextCursor: null }
    });
    expect(engine.listPlaylists).toHaveBeenCalledOnce();
  });

  it("세션이 준비된 뒤 비밀 오디오 URL을 Lavalink에만 넘기고 재생한다", async () => {
    const engine = createEngine();
    const player = createPlayer();
    const service = new DjPlaybackService(engine);

    await service.start(startInput(player));

    expect(engine.createSession).toHaveBeenCalledWith({
      energyProfile: "peak",
      idempotencyKey: "attempt-guild-1",
      maxDurationMinutes: 45,
      ownerRef: "guild-1",
      playlistId: "playlist-1"
    });
    expect(engine.waitUntilReady).toHaveBeenCalledWith("session-1");
    expect(player.search.mock.calls[0]?.slice(0, 2)).toEqual([
      AUDIO_URL,
      { id: "user-1" }
    ]);
    expect(player.queue.add).toHaveBeenCalledWith(expect.objectContaining({
      encoded: "encoded-dj-stream"
    }));
    expect(player.play).toHaveBeenCalledOnce();
    expect(engine.createSession.mock.invocationCallOrder[0]).toBeLessThan(
      engine.waitUntilReady.mock.invocationCallOrder[0]!
    );
    expect(engine.waitUntilReady.mock.invocationCallOrder[0]).toBeLessThan(
      player.search.mock.invocationCallOrder[0]!
    );
    expect(player.search.mock.invocationCallOrder[0]).toBeLessThan(
      player.queue.add.mock.invocationCallOrder[0]!
    );
    expect(player.queue.add.mock.invocationCallOrder[0]).toBeLessThan(
      player.play.mock.invocationCallOrder[0]!
    );
    expect(service.isActive("guild-1")).toBe(true);
  });

  it("Discord 표시용 트랙에는 스트림 URL과 capability token을 절대 보관하지 않는다", async () => {
    const engine = createEngine();
    const player = createPlayer();
    const service = new DjPlaybackService(engine);

    await service.start(startInput(player));
    const displayTrack = service.getDisplayTrack("guild-1");

    expect(displayTrack).toMatchObject({
      author: "DJ Engine",
      durationMs: 0,
      isSeekable: false,
      isStream: true,
      origin: "requested",
      requesterId: "user-1",
      sourceName: "djengine",
      title: "Friday Mix",
      uri: "https://djengine.local/session"
    });
    expect(displayTrack?.uri).not.toBe(AUDIO_URL);
    expect(JSON.stringify(displayTrack)).not.toContain(AUDIO_URL);
    expect(JSON.stringify(displayTrack)).not.toContain("super-secret-token");
    expect(JSON.stringify(displayTrack)).not.toContain("token=");
  });

  it("일시정지, 계속, 스킵은 Lavalink가 아니라 DJ Engine 내부 믹스에 명령한다", async () => {
    const engine = createEngine();
    const player = createPlayer();
    const service = new DjPlaybackService(engine);
    await service.start(startInput(player));
    engine.sendCommand.mockClear();

    await service.pause("guild-1", "pause-1");
    await service.resume("guild-1", "resume-1");
    await service.skip("guild-1", "skip-1");

    expect(engine.sendCommand.mock.calls).toEqual([
      ["session-1", "pause-1", { type: "pause" }, "immediate"],
      ["session-1", "resume-1", { type: "play" }, "immediate"],
      ["session-1", "skip-1", { type: "skip" }, "immediate"]
    ]);
    expect(player.pause).not.toHaveBeenCalled();
    expect(player.resume).not.toHaveBeenCalled();
    expect(player.skip).not.toHaveBeenCalled();
  });

  it("세션 준비 실패 시 생성된 세션을 닫고 활성 상태를 남기지 않는다", async () => {
    const engine = createEngine();
    const player = createPlayer();
    const service = new DjPlaybackService(engine);
    engine.waitUntilReady.mockRejectedValueOnce(new Error("analysis failed"));

    await expect(service.start(startInput(player))).rejects.toThrow("analysis failed");

    expect(engine.closeSession).toHaveBeenCalledOnce();
    expect(engine.closeSession).toHaveBeenCalledWith("session-1");
    expect(player.search).not.toHaveBeenCalled();
    expect(service.isActive("guild-1")).toBe(false);
    expect(service.getDisplayTrack("guild-1")).toBeUndefined();
  });

  it.each([
    ["HTTP 스트림 검색", "search"],
    ["Lavalink 대기열 추가", "add"],
    ["Lavalink 재생", "play"]
  ] as const)("%s 실패 시 엔진 세션을 닫는다", async (_label, failurePoint) => {
    const engine = createEngine();
    const player = createPlayer();
    const service = new DjPlaybackService(engine);
    if (failurePoint === "search") {
      player.search.mockResolvedValueOnce(searchResult([]));
    } else if (failurePoint === "add") {
      player.queue.add.mockRejectedValueOnce(new Error("queue failed"));
    } else {
      player.play.mockRejectedValueOnce(new Error("play failed"));
    }

    await expect(service.start(startInput(player))).rejects.toThrow();

    expect(engine.closeSession).toHaveBeenCalledOnce();
    expect(engine.closeSession).toHaveBeenCalledWith("session-1");
    expect(service.isActive("guild-1")).toBe(false);
  });

  it("정지 과정에서 Lavalink 중지가 실패해도 엔진 세션은 반드시 닫는다", async () => {
    const engine = createEngine();
    const player = createPlayer();
    const service = new DjPlaybackService(engine);
    await service.start(startInput(player));
    player.stopPlaying.mockRejectedValueOnce(new Error("lavalink unavailable"));

    await expect(service.stop("guild-1", player)).rejects.toThrow("lavalink unavailable");

    expect(player.stopPlaying).toHaveBeenCalledWith(true, false);
    expect(engine.closeSession).toHaveBeenCalledWith("session-1");
    expect(service.isActive("guild-1")).toBe(false);
  });

  it("정지는 Lavalink 재생과 플레이어를 종료한 뒤 엔진 세션을 닫는다", async () => {
    const engine = createEngine();
    const player = createPlayer();
    const service = new DjPlaybackService(engine);
    await service.start(startInput(player));

    await service.stop("guild-1", player);

    expect(player.stopPlaying).toHaveBeenCalledWith(true, false);
    expect(player.destroy).toHaveBeenCalledWith(expect.any(String));
    expect(engine.closeSession).toHaveBeenCalledWith("session-1");
    expect(player.stopPlaying.mock.invocationCallOrder[0]).toBeLessThan(
      player.destroy.mock.invocationCallOrder[0]!
    );
    expect(service.isActive("guild-1")).toBe(false);
  });

  it("이미 DJ 모드인 길드에서 두 번째 세션을 시작하지 않는다", async () => {
    const engine = createEngine();
    const firstPlayer = createPlayer();
    const secondPlayer = createPlayer();
    const service = new DjPlaybackService(engine);
    await service.start(startInput(firstPlayer));

    await expect(service.start(startInput(secondPlayer))).rejects.toThrow();

    expect(engine.createSession).toHaveBeenCalledOnce();
    expect(secondPlayer.search).not.toHaveBeenCalled();
    expect(service.isActive("guild-1")).toBe(true);
  });

  it("같은 길드 정리가 동시에 요청되어도 엔진 세션은 한 번만 닫는다", async () => {
    const engine = createEngine();
    const player = createPlayer();
    const service = new DjPlaybackService(engine);
    await service.start(startInput(player));
    let releaseClose: (() => void) | undefined;
    engine.closeSession.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        releaseClose = resolve;
      })
    );

    const first = service.closeGuild("guild-1");
    const second = service.closeGuild("guild-1");
    const third = service.closeGuild("guild-1");
    await vi.waitFor(() => expect(engine.closeSession).toHaveBeenCalledOnce());
    releaseClose?.();
    await Promise.all([first, second, third]);

    expect(engine.closeSession).toHaveBeenCalledWith("session-1");
    expect(service.isActive("guild-1")).toBe(false);
    await service.closeGuild("guild-1");
    expect(engine.closeSession).toHaveBeenCalledOnce();
  });

  it("closeAll은 활성 길드들을 각각 한 번씩 정리하고 표시 상태도 비운다", async () => {
    const engine = createEngine();
    engine.createSession
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(session({
        audioUrl:
          "http://djengine:8787/api/v1/sessions/session-2/audio.ogg?token=second-secret",
        id: "session-2",
        ownerRef: "guild-2"
      }));
    const firstPlayer = createPlayer();
    const secondPlayer = createPlayer(rawDjTrack(
      "http://djengine:8787/api/v1/sessions/session-2/audio.ogg?token=second-secret"
    ));
    const service = new DjPlaybackService(engine);
    await service.start(startInput(firstPlayer));
    await service.start(startInput(secondPlayer, "guild-2"));
    engine.closeSession.mockClear();

    await Promise.all([service.closeAll(), service.closeAll()]);

    expect(engine.closeSession).toHaveBeenCalledTimes(2);
    expect(new Set(engine.closeSession.mock.calls.map(([sessionId]) => sessionId))).toEqual(
      new Set(["session-1", "session-2"])
    );
    expect(service.isActive("guild-1")).toBe(false);
    expect(service.isActive("guild-2")).toBe(false);
    expect(service.getDisplayTrack("guild-1")).toBeUndefined();
    expect(service.getDisplayTrack("guild-2")).toBeUndefined();
  });
});
