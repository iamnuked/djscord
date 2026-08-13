import type { Track, UnresolvedTrack } from "lavalink-client";

import type { MusicTrack } from "../domain/types.js";
import type {
  CreateDjSessionInput,
  DjCommandType,
  DjEngineEvent,
  DjEnergyProfile,
  DjPlaylist,
  DjScheduledCommand,
  DjSession,
  DjSessionView
} from "../infrastructure/djengine-client.js";

interface DjEnginePort {
  closeSession(sessionId: string): Promise<void>;
  createSession(input: CreateDjSessionInput): Promise<DjSession>;
  listPlaylists(): Promise<DjPlaylist[] | { data: DjPlaylist[]; meta: unknown }>;
  sendCommand(
    sessionId: string,
    commandId: string,
    command: DjCommandType | { type: DjCommandType },
    quantize?: DjScheduledCommand["quantize"]
  ): Promise<unknown>;
  waitUntilReady(
    sessionId: string,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<DjSessionView>;
  watchEvents?(
    sessionId: string,
    options?: { lastEventId?: number; signal?: AbortSignal }
  ): AsyncIterable<DjEngineEvent>;
}

interface DjMixPublisherPort {
  getMixUrl(guildId: string): string;
  start(options: {
    guildId: string;
    ownerRef: string;
    playlist: { id: string; name: string };
    sessionId: string;
  }): void;
  stop(guildId: string): Promise<void>;
}

export interface DjLavalinkPlayerPort {
  destroy?(reason: string): Promise<unknown>;
  play(): Promise<unknown>;
  queue: { add(track: Track | UnresolvedTrack): Promise<unknown> };
  search(
    query: string,
    requester: { id: string },
    throwOnEmpty?: boolean
  ): Promise<{ tracks: (Track | UnresolvedTrack)[] }>;
  stopPlaying(clearQueue?: boolean, executeAutoplay?: boolean): Promise<unknown>;
}

interface StartOptions {
  energyProfile?: DjEnergyProfile;
  guildId: string;
  idempotencyKey?: string;
  maxDurationMinutes?: number;
  ownerRef: string;
  player: DjLavalinkPlayerPort;
  playlistId: string;
  playlistName: string;
  requesterId: string;
}

interface ActiveDjSession {
  abortController: AbortController;
  displayTrack: MusicTrack;
  paused: boolean;
  player: DjLavalinkPlayerPort;
  sessionId: string;
}

interface StartingDjSession {
  abortController: AbortController;
  cancelled: boolean;
  done: Promise<void>;
  player: DjLavalinkPlayerPort;
  resolveDone: () => void;
  sessionId?: string;
}

interface ClosingDjSession {
  inFlight?: Promise<void>;
  player: DjLavalinkPlayerPort;
  sessionId: string;
}

interface DjPlaybackServiceOptions {
  eventReconnectBaseMs?: number;
  eventReconnectMaxMs?: number;
  terminalCloseRetryAttempts?: number;
  terminalCloseRetryDelayMs?: number;
}

export class DjPlaybackService {
  readonly #active = new Map<string, ActiveDjSession>();
  readonly #closing = new Map<string, ClosingDjSession>();
  readonly #engine: DjEnginePort;
  readonly #eventReconnectBaseMs: number;
  readonly #eventReconnectMaxMs: number;
  readonly #mixPublisher: DjMixPublisherPort | undefined;
  readonly #starting = new Map<string, StartingDjSession>();
  readonly #terminalCloseRetryAttempts: number;
  readonly #terminalCloseRetryDelayMs: number;
  #shuttingDown = false;

  constructor(
    engine: DjEnginePort,
    mixPublisher?: DjMixPublisherPort,
    options: DjPlaybackServiceOptions = {}
  ) {
    this.#engine = engine;
    this.#mixPublisher = mixPublisher;
    this.#eventReconnectBaseMs = options.eventReconnectBaseMs ?? 250;
    this.#eventReconnectMaxMs = options.eventReconnectMaxMs ?? 5_000;
    this.#terminalCloseRetryAttempts = options.terminalCloseRetryAttempts ?? 3;
    this.#terminalCloseRetryDelayMs = options.terminalCloseRetryDelayMs ?? 1_000;
    if (
      this.#eventReconnectBaseMs <= 0 ||
      this.#eventReconnectMaxMs < this.#eventReconnectBaseMs ||
      !Number.isSafeInteger(this.#terminalCloseRetryAttempts) ||
      this.#terminalCloseRetryAttempts < 0 ||
      !Number.isSafeInteger(this.#terminalCloseRetryDelayMs) ||
      this.#terminalCloseRetryDelayMs <= 0
    ) {
      throw new Error("DJ Engine 재연결 또는 종료 재시도 설정이 올바르지 않습니다.");
    }
  }

  listPlaylists() {
    return this.#engine.listPlaylists();
  }

  isActive(guildId: string): boolean {
    return this.#active.has(guildId)
      || this.#starting.has(guildId)
      || this.#closing.has(guildId);
  }

  ownsPlayer(guildId: string, player: DjLavalinkPlayerPort): boolean {
    return this.#active.get(guildId)?.player === player
      || this.#starting.get(guildId)?.player === player
      || this.#closing.get(guildId)?.player === player;
  }

  isPaused(guildId: string): boolean {
    return this.#active.get(guildId)?.paused ?? false;
  }

  getDisplayTrack(guildId: string): MusicTrack | undefined {
    return this.#active.get(guildId)?.displayTrack;
  }

  getMixUrl(guildId: string): string | undefined {
    return this.#mixPublisher?.getMixUrl(guildId);
  }

  async start(options: StartOptions): Promise<MusicTrack> {
    if (this.#shuttingDown) {
      throw new Error("DJ Engine 재생 서비스가 종료 중이라 새 세션을 시작할 수 없습니다.");
    }
    if (this.isActive(options.guildId)) {
      throw new Error("이 서버에는 이미 DJ Engine 세션이 있습니다. 먼저 `/디제이 종료`를 사용해주세요.");
    }
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const abortController = new AbortController();
    const starting: StartingDjSession = {
      abortController,
      cancelled: false,
      done,
      player: options.player,
      resolveDone
    };
    this.#starting.set(options.guildId, starting);
    let sessionId: string | undefined;
    try {
      const session = await this.#engine.createSession({
        ...(options.energyProfile === undefined ? {} : { energyProfile: options.energyProfile }),
        ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
        ...(options.maxDurationMinutes === undefined
          ? {}
          : { maxDurationMinutes: options.maxDurationMinutes }),
        ownerRef: options.ownerRef,
        playlistId: options.playlistId
      });
      sessionId = session.id;
      starting.sessionId = session.id;
      if (starting.cancelled) {
        throw new Error("DJ Engine 세션 시작이 취소되었습니다.");
      }
      const displayTrack = createDisplayTrack(options, session.id);
      this.#active.set(options.guildId, {
        abortController,
        displayTrack,
        paused: false,
        player: options.player,
        sessionId
      });
      await this.#engine.waitUntilReady(session.id, {
        signal: abortController.signal
      });
      if (starting.cancelled) {
        throw new Error("DJ Engine 세션 시작이 취소되었습니다.");
      }

      const result = await raceWithAbort(
        options.player.search(
          session.audioUrl,
          { id: options.requesterId },
          false
        ),
        abortController.signal
      );
      if (starting.cancelled) {
        throw new Error("DJ Engine 세션 시작이 취소되었습니다.");
      }
      const rawTrack = result.tracks[0];
      if (rawTrack === undefined || "resolve" in rawTrack) {
        throw new Error("DJ Engine 스트림을 Lavalink에서 불러오지 못했습니다.");
      }
      rawTrack.userData = { ...rawTrack.userData, djengine: 1 };
      await raceWithAbort(options.player.queue.add(rawTrack), abortController.signal);
      if (starting.cancelled) {
        throw new Error("DJ Engine 세션 시작이 취소되었습니다.");
      }
      await raceWithAbort(options.player.play(), abortController.signal);
      if (starting.cancelled) {
        throw new Error("DJ Engine 세션 시작이 취소되었습니다.");
      }
      try {
        this.#mixPublisher?.start({
          guildId: options.guildId,
          ownerRef: options.ownerRef,
          playlist: { id: options.playlistId, name: options.playlistName },
          sessionId: session.id
        });
      } catch {
        console.error(`선택적인 mix publisher를 시작하지 못했습니다: guild=${options.guildId}`);
      }
      this.#watchTerminalEvents(
        options.guildId,
        session.id,
        options.player,
        abortController.signal
      );
      return displayTrack;
    } catch (error) {
      abortController.abort();
      const startError = starting.cancelled
        ? new Error("DJ Engine 세션 시작이 취소되었습니다.")
        : error;
      const active = this.#active.get(options.guildId);
      if (active?.sessionId === sessionId) this.#active.delete(options.guildId);
      const cleanup: Promise<unknown>[] = [];
      if (starting.cancelled) {
        cleanup.push(attempt(() => options.player.stopPlaying(true, false)));
        if (options.player.destroy !== undefined) {
          cleanup.push(attempt(() => options.player.destroy!("DJ Engine 세션 시작 취소")));
        }
      }
      if (sessionId !== undefined) {
        cleanup.push(
          this.#closeSession(options.guildId, sessionId, options.player)
            .catch(() => undefined)
        );
      }
      await Promise.allSettled(cleanup);
      throw startError;
    } finally {
      if (this.#starting.get(options.guildId) === starting) {
        this.#starting.delete(options.guildId);
      }
      starting.resolveDone();
    }
  }

  async pause(guildId: string, commandId: string): Promise<unknown> {
    return this.#control(guildId, commandId, "pause", true);
  }

  async resume(guildId: string, commandId: string): Promise<unknown> {
    return this.#control(guildId, commandId, "play", false);
  }

  skip(guildId: string, commandId: string): Promise<unknown> {
    return this.#control(guildId, commandId, "skip");
  }

  async stop(guildId: string, player: DjLavalinkPlayerPort): Promise<void> {
    const failures: unknown[] = [];
    await attempt(() => player.stopPlaying(true, false)).catch((error: unknown) => {
      failures.push(error);
    });
    if (player.destroy !== undefined) {
      await attempt(() => player.destroy!("DJ Engine 세션 종료")).catch((error: unknown) => {
        failures.push(error);
      });
    }
    await this.closeGuild(guildId, player).catch((error: unknown) => {
      failures.push(error);
    });
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "DJ Engine 재생 정리에 실패했습니다.");
    }
  }

  closeGuild(guildId: string, player?: DjLavalinkPlayerPort): Promise<void> {
    const starting = this.#starting.get(guildId);
    const active = this.#active.get(guildId);
    const closing = this.#closing.get(guildId);
    const owner = active?.player ?? starting?.player ?? closing?.player;
    if (player !== undefined && owner !== player) return Promise.resolve();

    if (starting !== undefined) {
      starting.cancelled = true;
      starting.abortController.abort();
      if (active !== undefined) {
        this.#active.delete(guildId);
        active.abortController.abort();
      }
      return starting.done;
    }

    if (closing !== undefined) return this.#attemptClose(guildId, closing);
    if (active === undefined) return Promise.resolve();
    this.#active.delete(guildId);
    active.abortController.abort();
    return this.#closeSession(guildId, active.sessionId, active.player);
  }

  async closeAll(): Promise<void> {
    this.#shuttingDown = true;
    const starting = [...this.#starting.values()];
    const initialGuildIds = new Set([
      ...this.#active.keys(),
      ...this.#starting.keys(),
      ...this.#closing.keys()
    ]);
    await Promise.allSettled(
      [...initialGuildIds].map((guildId) => this.closeGuild(guildId))
    );
    await Promise.allSettled(starting.map(({ done }) => done));

    // 시작 취소의 finally에서 생긴 tombstone과 일시적인 DELETE 실패를 한 번 더 정리합니다.
    const remainingGuildIds = new Set([
      ...this.#active.keys(),
      ...this.#starting.keys(),
      ...this.#closing.keys()
    ]);
    const results = await Promise.allSettled(
      [...remainingGuildIds].map((guildId) => this.closeGuild(guildId))
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "DJ Engine 세션 정리에 실패했습니다.");
    }
  }

  async #control(
    guildId: string,
    commandId: string,
    type: DjCommandType,
    paused?: boolean
  ): Promise<unknown> {
    const active = this.#active.get(guildId);
    if (active === undefined) throw new Error("현재 DJ Engine 세션이 없습니다.");
    const result = await this.#engine.sendCommand(
      active.sessionId,
      commandId,
      { type },
      "next_bar"
    );
    if (paused !== undefined && this.#active.get(guildId) === active) active.paused = paused;
    return result;
  }

  #watchTerminalEvents(
    guildId: string,
    sessionId: string,
    player: DjLavalinkPlayerPort,
    signal: AbortSignal
  ): void {
    if (this.#engine.watchEvents === undefined) return;
    void (async () => {
      let lastEventId: number | undefined;
      let reconnectDelayMs = this.#eventReconnectBaseMs;
      while (!signal.aborted) {
        try {
          for await (const event of this.#engine.watchEvents!(sessionId, {
            ...(lastEventId === undefined ? {} : { lastEventId }),
            signal
          })) {
            if (Number.isSafeInteger(event.id) && event.id >= 0) lastEventId = event.id;
            reconnectDelayMs = this.#eventReconnectBaseMs;
            if (event.event === "session.finished" || event.event === "error") {
              await this.#finishFromEngine(guildId, sessionId, player);
              return;
            }
          }
        } catch {
          if (signal.aborted) return;
        }
        try {
          await waitForReconnect(reconnectDelayMs, signal);
        } catch {
          return;
        }
        reconnectDelayMs = Math.min(
          this.#eventReconnectMaxMs,
          reconnectDelayMs * 2
        );
      }
    })();
  }

  async #finishFromEngine(
    guildId: string,
    sessionId: string,
    player: DjLavalinkPlayerPort
  ): Promise<void> {
    const active = this.#active.get(guildId);
    if (active?.sessionId !== sessionId || active.player !== player) return;
    await attempt(() => player.stopPlaying(true, false)).catch(() => undefined);
    if (player.destroy !== undefined) {
      await attempt(() => player.destroy!("DJ Engine 믹스 종료")).catch(() => undefined);
    }
    // Engine은 terminal monitor를 events보다 먼저 publish한다. DELETE가 SSE를
    // 닫기 전에 publisher에 짧은 grace를 주어 최종 상태를 저장한다.
    await this.#mixPublisher?.stop(guildId).catch(() => undefined);
    try {
      await this.closeGuild(guildId, player);
      return;
    } catch {
      // 아래의 bounded retry에서 동일한 closing tombstone을 다시 정리합니다.
    }
    for (let attemptIndex = 0; attemptIndex < this.#terminalCloseRetryAttempts; attemptIndex += 1) {
      await unrefDelay(this.#terminalCloseRetryDelayMs);
      try {
        await this.closeGuild(guildId, player);
        return;
      } catch {
        // terminal 자동 정리는 설정된 횟수까지 계속 재시도합니다.
      }
    }
    console.error(`DJ Engine 자동 종료 재시도에 실패했습니다: guild=${guildId}`);
  }

  #closeSession(
    guildId: string,
    sessionId: string,
    player: DjLavalinkPlayerPort
  ): Promise<void> {
    const existing = this.#closing.get(guildId);
    if (existing !== undefined) return this.#attemptClose(guildId, existing);
    const closing: ClosingDjSession = { player, sessionId };
    this.#closing.set(guildId, closing);
    return this.#attemptClose(guildId, closing);
  }

  #attemptClose(guildId: string, closing: ClosingDjSession): Promise<void> {
    if (closing.inFlight !== undefined) return closing.inFlight;
    const request = Promise.all([
      attempt(() => this.#engine.closeSession(closing.sessionId)),
      this.#mixPublisher === undefined
        ? Promise.resolve()
        : attempt(() => this.#mixPublisher!.stop(guildId)).catch(() => {
            console.error(`선택적인 mix publisher를 정리하지 못했습니다: guild=${guildId}`);
          })
    ]).then(() => undefined).catch((error: unknown) => {
      if (this.#closing.get(guildId) === closing) delete closing.inFlight;
      throw error;
    });
    closing.inFlight = request.then(() => {
      if (this.#closing.get(guildId) === closing) this.#closing.delete(guildId);
    });
    return closing.inFlight;
  }
}

function createDisplayTrack(options: StartOptions, sessionId: string): MusicTrack {
  return {
    author: "DJ Engine",
    durationMs: 0,
    identifier: `djengine:${sessionId}`,
    isSeekable: false,
    isStream: true,
    origin: "requested",
    requesterId: options.requesterId,
    sourceName: "djengine",
    title: [...options.playlistName].slice(0, 240).join(""),
    uri: "https://djengine.local/session"
  };
}

function attempt<T>(action: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(action);
}

function waitForReconnect(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function unrefDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    timeout.unref();
  });
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
