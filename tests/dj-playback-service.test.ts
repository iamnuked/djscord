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
      sourceName: "youtube",
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
  const ready = {
    createdAt: created.createdAt,
    currentTrackId: created.currentTrackId,
    id: created.id,
    ownerRef: created.ownerRef,
    playlistId: created.playlistId,
    status: "ready" as const
  };
  return {
    closeSession: vi.fn<(_sessionId: string) => Promise<void>>().mockResolvedValue(undefined),
    createSession: vi
      .fn<(_input: unknown) => Promise<TestSession>>()
      .mockResolvedValue(created),
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
    waitUntilReady: vi
      .fn<(
        _sessionId: string,
        _options?: { signal?: AbortSignal; timeoutMs?: number }
      ) => Promise<typeof ready>>()
      .mockResolvedValue(ready)
  };
}

function createPlayer(track = rawDjTrack()) {
  return {
    destroy: vi.fn<(_reason: string) => Promise<void>>().mockResolvedValue(undefined),
    pause: vi.fn(async () => undefined),
    play: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    queue: {
      add: vi.fn<(_track: Track) => Promise<void>>().mockResolvedValue(undefined)
    },
    resume: vi.fn(async () => undefined),
    search: vi
      .fn<(
        _query: string,
        _requester: { id: string },
        _throwOnEmpty?: boolean
      ) => Promise<SearchResult>>()
      .mockResolvedValue(searchResult([track])),
    skip: vi.fn(async () => undefined),
    stopPlaying: vi
      .fn<(_clearQueue?: boolean, _executeAutoplay?: boolean) => Promise<void>>()
      .mockResolvedValue(undefined)
  };
}

function startInput(player: ReturnType<typeof createPlayer>, guildId = "guild-1") {
  return {
    energyProfile: "peak" as const,
    guildId,
    idempotencyKey: `attempt-${guildId}`,
    maxDurationMinutes: 45,
    ownerRef: `discord:guild:${guildId}`,
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
      ownerRef: "discord:guild:guild-1",
      playlistId: "playlist-1"
    });
    expect(engine.waitUntilReady).toHaveBeenCalledWith("session-1", {
      signal: expect.any(Object)
    });
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

  it("Lavalink 재생 뒤 mix publisher를 시작하고 세션 정리와 함께 cleanup한다", async () => {
    const engine = createEngine();
    const player = createPlayer();
    const publisher = {
      getMixUrl: vi.fn(() => "https://djscord.example/mix?guild=guild-1"),
      start: vi.fn(),
      stop: vi.fn(async () => undefined)
    };
    const service = new DjPlaybackService(engine, publisher);

    await service.start(startInput(player));

    expect(publisher.start).toHaveBeenCalledWith({
      guildId: "guild-1",
      ownerRef: "discord:guild:guild-1",
      playlist: { id: "playlist-1", name: "Friday Mix" },
      sessionId: "session-1"
    });
    expect(player.play.mock.invocationCallOrder[0]).toBeLessThan(
      publisher.start.mock.invocationCallOrder[0]!
    );
    expect(service.getMixUrl("guild-1")).toBe(
      "https://djscord.example/mix?guild=guild-1"
    );

    await service.closeGuild("guild-1", player);

    expect(publisher.stop).toHaveBeenCalledOnce();
    expect(publisher.stop).toHaveBeenCalledWith("guild-1");
  });

  it("선택적인 mix cleanup 실패가 엔진 종료나 다음 DJ 시작을 막지 않는다", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const engine = createEngine();
    const firstPlayer = createPlayer();
    const publisher = {
      getMixUrl: vi.fn(() => "https://djscord.example/mix?guild=guild-1"),
      start: vi.fn(),
      stop: vi.fn().mockRejectedValue(new Error("ingest unavailable"))
    };
    const service = new DjPlaybackService(engine, publisher);
    await service.start(startInput(firstPlayer));

    await expect(service.closeGuild("guild-1", firstPlayer)).resolves.toBeUndefined();

    expect(engine.closeSession).toHaveBeenCalledWith("session-1");
    expect(service.isActive("guild-1")).toBe(false);
    engine.createSession.mockResolvedValueOnce(session());
    await expect(service.start(startInput(createPlayer()))).resolves.toBeDefined();
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("mix publisher"));
    errorLog.mockRestore();
  });

  it("Discord 표시용 플레이리스트 제목은 embed 제한보다 짧게 자른다", async () => {
    const engine = createEngine();
    const player = createPlayer();
    const service = new DjPlaybackService(engine);

    await service.start({
      ...startInput(player),
      playlistName: "🎵".repeat(300)
    });

    expect([...(service.getDisplayTrack("guild-1")?.title ?? "")]).toHaveLength(240);
  });

  it("일시정지, 계속, 스킵은 next_bar로 DJ Engine 내부 믹스에 명령한다", async () => {
    const engine = createEngine();
    const player = createPlayer();
    const service = new DjPlaybackService(engine);
    await service.start(startInput(player));
    engine.sendCommand.mockClear();

    await service.pause("guild-1", "pause-1");
    await service.resume("guild-1", "resume-1");
    await service.skip("guild-1", "skip-1");

    expect(engine.sendCommand.mock.calls).toEqual([
      ["session-1", "pause-1", { type: "pause" }, "next_bar"],
      ["session-1", "resume-1", { type: "play" }, "next_bar"],
      ["session-1", "skip-1", { type: "skip" }, "next_bar"]
    ]);
    expect(player.pause).not.toHaveBeenCalled();
    expect(player.resume).not.toHaveBeenCalled();
    expect(player.skip).not.toHaveBeenCalled();
  });

  it("엔진 제어 명령이 실패하면 일시정지 표시 상태를 바꾸지 않는다", async () => {
    const engine = createEngine();
    const player = createPlayer();
    const service = new DjPlaybackService(engine);
    await service.start(startInput(player));
    engine.sendCommand.mockRejectedValueOnce(new Error("engine unavailable"));

    await expect(service.pause("guild-1", "pause-failed")).rejects.toThrow(
      "engine unavailable"
    );

    expect(service.isPaused("guild-1")).toBe(false);
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
    expect(player.destroy).toHaveBeenCalledWith(expect.any(String));
    expect(engine.closeSession).toHaveBeenCalledWith("session-1");
    expect(service.isActive("guild-1")).toBe(false);
  });

  it("Lavalink 플레이어 파괴가 실패해도 엔진 세션은 반드시 닫는다", async () => {
    const engine = createEngine();
    const player = createPlayer();
    const service = new DjPlaybackService(engine);
    await service.start(startInput(player));
    player.destroy.mockRejectedValueOnce(new Error("destroy unavailable"));

    await expect(service.stop("guild-1", player)).rejects.toThrow("destroy unavailable");

    expect(player.stopPlaying).toHaveBeenCalledWith(true, false);
    expect(engine.closeSession).toHaveBeenCalledWith("session-1");
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
    expect(player.destroy.mock.invocationCallOrder[0]).toBeLessThan(
      engine.closeSession.mock.invocationCallOrder[0]!
    );
    expect(service.isActive("guild-1")).toBe(false);
  });

  it("Lavalink 중지가 끝나기 전에는 player destroy와 엔진 DELETE를 시작하지 않는다", async () => {
    let releaseStop: (() => void) | undefined;
    const engine = createEngine();
    const player = createPlayer();
    const service = new DjPlaybackService(engine);
    await service.start(startInput(player));
    player.stopPlaying.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseStop = resolve;
    }));

    const stopping = service.stop("guild-1", player);
    await vi.waitFor(() => expect(player.stopPlaying).toHaveBeenCalledOnce());
    expect(player.destroy).not.toHaveBeenCalled();
    expect(engine.closeSession).not.toHaveBeenCalled();

    releaseStop?.();
    await stopping;
    expect(player.destroy).toHaveBeenCalledOnce();
    expect(engine.closeSession).toHaveBeenCalledWith("session-1");
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

  it("오래된 플레이어의 destroy 이벤트는 새 세션을 닫지 않는다", async () => {
    const engine = createEngine();
    const activePlayer = createPlayer();
    const stalePlayer = createPlayer();
    const service = new DjPlaybackService(engine);
    await service.start(startInput(activePlayer));

    expect(service.ownsPlayer("guild-1", activePlayer)).toBe(true);
    expect(service.ownsPlayer("guild-1", stalePlayer)).toBe(false);
    await service.closeGuild("guild-1", stalePlayer);

    expect(engine.closeSession).not.toHaveBeenCalled();
    expect(service.isActive("guild-1")).toBe(true);
  });

  it("봇 종료가 세션 준비 중에 발생해도 생성된 엔진 세션을 닫는다", async () => {
    let releaseReady: (() => void) | undefined;
    const engine = createEngine();
    engine.waitUntilReady.mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseReady = () => resolve({
          createdAt: "2026-08-13T00:00:00Z",
          currentTrackId: null,
          id: "session-1",
          ownerRef: "guild-1",
          playlistId: "playlist-1",
          status: "ready"
        });
      })
    );
    const player = createPlayer();
    const service = new DjPlaybackService(engine);
    const start = service.start(startInput(player));
    await vi.waitFor(() => expect(engine.waitUntilReady).toHaveBeenCalledOnce());

    const waitSignal = engine.waitUntilReady.mock.calls[0]?.[1]?.signal;
    const closing = service.closeAll();
    expect(waitSignal?.aborted).toBe(true);
    releaseReady?.();
    await closing;
    await expect(start).rejects.toThrow(/취소/u);

    expect(engine.closeSession).toHaveBeenCalledWith("session-1");
    expect(player.search).not.toHaveBeenCalled();
    expect(service.isActive("guild-1")).toBe(false);
  });

  it("Lavalink play 대기 중 종료해도 await 뒤 취소를 확인하고 세션을 닫는다", async () => {
    let releasePlay: (() => void) | undefined;
    const engine = createEngine();
    const player = createPlayer();
    player.play.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        releasePlay = resolve;
      })
    );
    const service = new DjPlaybackService(engine);
    const start = service.start(startInput(player));
    await vi.waitFor(() => expect(player.play).toHaveBeenCalledOnce());

    const closing = service.closeGuild("guild-1", player);
    releasePlay?.();
    await closing;
    await expect(start).rejects.toThrow(/취소/u);

    expect(engine.closeSession).toHaveBeenCalledWith("session-1");
    expect(service.isActive("guild-1")).toBe(false);
  });

  it("Lavalink search가 응답하지 않아도 종료 신호가 시작 작업을 즉시 취소한다", async () => {
    const engine = createEngine();
    const player = createPlayer();
    player.search.mockImplementationOnce(() => new Promise<SearchResult>(() => undefined));
    const service = new DjPlaybackService(engine);
    const start = service.start(startInput(player));
    await vi.waitFor(() => expect(player.search).toHaveBeenCalledOnce());

    const closing = service.closeGuild("guild-1", player);
    const closedPromptly = await Promise.race([
      closing.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100))
    ]);

    expect(closedPromptly).toBe(true);
    await expect(start).rejects.toThrow(/취소/u);
    expect(engine.closeSession).toHaveBeenCalledWith("session-1");
    expect(service.isActive("guild-1")).toBe(false);
  });

  it("엔진 완료 이벤트가 오면 Lavalink와 엔진 세션을 즉시 정리한다", async () => {
    let finish: (() => void) | undefined;
    async function* events() {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      yield { at: "2026-08-13T00:01:00Z", data: {}, event: "session.finished", id: 1 };
    }
    const engine = {
      ...createEngine(),
      watchEvents: vi.fn(() => events())
    };
    const player = createPlayer();
    const service = new DjPlaybackService(engine);
    await service.start(startInput(player));

    finish?.();
    await vi.waitFor(() => expect(engine.closeSession).toHaveBeenCalledWith("session-1"));

    expect(player.stopPlaying).toHaveBeenCalledWith(true, false);
    expect(player.destroy).toHaveBeenCalledWith(expect.any(String));
    expect(service.isActive("guild-1")).toBe(false);
  });

  it("terminal 이벤트 뒤 첫 DELETE가 실패하면 백그라운드에서 재시도해 tombstone을 정리한다", async () => {
    async function* events() {
      yield { at: "2026-08-13T00:01:00Z", data: {}, event: "session.finished", id: 1 };
    }
    const engine = {
      ...createEngine(),
      watchEvents: vi.fn(() => events())
    };
    engine.closeSession
      .mockRejectedValueOnce(new Error("temporary engine failure"))
      .mockResolvedValueOnce(undefined);
    const player = createPlayer();
    const service = new DjPlaybackService(engine, undefined, {
      terminalCloseRetryAttempts: 2,
      terminalCloseRetryDelayMs: 1
    });

    await service.start(startInput(player));

    await vi.waitFor(() => expect(engine.closeSession).toHaveBeenCalledTimes(2));
    expect(service.isActive("guild-1")).toBe(false);
  });

  it("terminal DELETE가 계속 실패해도 설정된 횟수까지만 재시도하고 tombstone을 보존한다", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      async function* events() {
        yield { at: "2026-08-13T00:01:00Z", data: {}, event: "session.finished", id: 1 };
      }
      const engine = {
        ...createEngine(),
        watchEvents: vi.fn(() => events())
      };
      engine.closeSession.mockRejectedValue(new Error("engine unavailable"));
      const service = new DjPlaybackService(engine, undefined, {
        terminalCloseRetryAttempts: 2,
        terminalCloseRetryDelayMs: 1
      });

      await service.start(startInput(createPlayer()));

      await vi.waitFor(() => expect(engine.closeSession).toHaveBeenCalledTimes(3));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(engine.closeSession).toHaveBeenCalledTimes(3);
      expect(service.isActive("guild-1")).toBe(true);
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining("자동 종료 재시도")
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it("events SSE가 잠시 끊기면 마지막 ID부터 재연결하고 재생을 유지한다", async () => {
    let finish: (() => void) | undefined;
    async function* firstConnection() {
      yield { at: "2026-08-13T00:00:30Z", data: {}, event: "session.ready", id: 7 };
    }
    async function* secondConnection() {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      yield { at: "2026-08-13T00:01:00Z", data: {}, event: "session.finished", id: 8 };
    }
    let connection = 0;
    const engine = {
      ...createEngine(),
      watchEvents: vi.fn((sessionId: string, options?: {
        lastEventId?: number;
        signal?: AbortSignal;
      }) => {
        void sessionId;
        void options;
        return connection++ === 0 ? firstConnection() : secondConnection();
      })
    };
    const player = createPlayer();
    const service = new DjPlaybackService(engine, undefined, {
      eventReconnectBaseMs: 1,
      eventReconnectMaxMs: 1
    });
    await service.start(startInput(player));

    await vi.waitFor(() => expect(engine.watchEvents).toHaveBeenCalledTimes(2));
    expect(engine.watchEvents.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      lastEventId: 7
    }));
    expect(engine.closeSession).not.toHaveBeenCalled();
    expect(service.isActive("guild-1")).toBe(true);

    finish?.();
    await vi.waitFor(() => expect(engine.closeSession).toHaveBeenCalledWith("session-1"));
    expect(service.isActive("guild-1")).toBe(false);
  });

  it("events SSE 404나 네트워크 오류는 terminal 증거가 아니므로 재연결한다", async () => {
    let finish: (() => void) | undefined;
    async function* missingConnection() {
      throw Object.assign(new Error("temporarily unavailable"), { status: 404 });
      yield { at: "", data: {}, event: "session.ready", id: 0 };
    }
    async function* recoveredConnection() {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      yield { at: "2026-08-13T00:01:00Z", data: {}, event: "session.finished", id: 9 };
    }
    let connection = 0;
    const engine = {
      ...createEngine(),
      watchEvents: vi.fn(() => connection++ === 0
        ? missingConnection()
        : recoveredConnection())
    };
    const player = createPlayer();
    const service = new DjPlaybackService(engine, undefined, {
      eventReconnectBaseMs: 1,
      eventReconnectMaxMs: 1
    });
    await service.start(startInput(player));

    await vi.waitFor(() => expect(engine.watchEvents).toHaveBeenCalledTimes(2));
    expect(engine.closeSession).not.toHaveBeenCalled();
    expect(service.isActive("guild-1")).toBe(true);

    finish?.();
    await vi.waitFor(() => expect(engine.closeSession).toHaveBeenCalledWith("session-1"));
    expect(service.isActive("guild-1")).toBe(false);
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

  it("엔진 DELETE 실패 시 종료 tombstone을 보존해 새 시작을 막고 재시도한다", async () => {
    const engine = createEngine();
    const player = createPlayer();
    const replacement = createPlayer();
    const service = new DjPlaybackService(engine);
    await service.start(startInput(player));
    engine.closeSession
      .mockRejectedValueOnce(new Error("engine unavailable"))
      .mockResolvedValueOnce(undefined);

    await expect(service.closeGuild("guild-1", player)).rejects.toThrow(
      "engine unavailable"
    );
    expect(service.isActive("guild-1")).toBe(true);
    expect(service.ownsPlayer("guild-1", player)).toBe(true);
    await expect(service.start(startInput(replacement))).rejects.toThrow(/이미/u);

    await service.closeGuild("guild-1", player);

    expect(engine.closeSession.mock.calls).toEqual([["session-1"], ["session-1"]]);
    expect(service.isActive("guild-1")).toBe(false);
  });

  it("closeAll은 종료 실패를 숨기지 않고 tombstone을 남겨 다음 정리에서 재시도한다", async () => {
    const engine = createEngine();
    const player = createPlayer();
    const service = new DjPlaybackService(engine);
    await service.start(startInput(player));
    engine.closeSession.mockRejectedValue(new Error("engine unavailable"));

    await expect(service.closeAll()).rejects.toThrow(/정리|engine unavailable/u);

    expect(service.isActive("guild-1")).toBe(true);
    engine.closeSession.mockResolvedValue(undefined);
    await service.closeAll();
    expect(service.isActive("guild-1")).toBe(false);
  });

  it("closeAll 호출 순간부터 이후의 모든 새 세션 시작을 영구 거절한다", async () => {
    const engine = createEngine();
    const service = new DjPlaybackService(engine);

    const closing = service.closeAll();
    await expect(service.start(startInput(createPlayer()))).rejects.toThrow(/종료/u);
    await closing;
    await expect(service.start(startInput(createPlayer()))).rejects.toThrow(/종료/u);

    expect(engine.createSession).not.toHaveBeenCalled();
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
