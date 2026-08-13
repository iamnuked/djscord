import { describe, expect, it, vi } from "vitest";

import type { DjMonitorSnapshot, DjWaveform } from "../src/infrastructure/djengine-client.js";
import type {
  MixCleanup,
  MixSnapshot
} from "../src/infrastructure/mix-ingest-client.js";
import { DjMixPublisher } from "../src/music/dj-mix-publisher.js";

function monitor(): DjMonitorSnapshot {
  return {
    capturedAt: "2026-08-13T00:00:00Z",
    decks: {
      a: {
        artist: "Artist",
        durationMs: 180_000,
        gains: { high: 1, low: 1, mid: 1 },
        loop: null,
        musicalKey: "8A",
        playbackBpm: 128,
        positionMs: 1_000,
        sourceRate: 1,
        state: "playing",
        title: "Track",
        trackId: "track-1",
        waveformId: "waveform-sha256-1"
      },
      b: null
    },
    master: { peakLeft: 0.3, peakRight: 0.4 },
    outputSample: 48_000,
    playing: true,
    revision: 1,
    sampleRate: 48_000,
    schemaVersion: 1,
    sessionId: "session-1",
    status: "ready",
    transition: null
  };
}

function snapshotResult(sequence = 1) {
  return {
    feedId: "feed-1",
    missingWaveformIds: [],
    mixUrl: "https://djscord.example/mix?guild=guild-1",
    revision: sequence
  };
}

describe("DjMixPublisher", () => {
  it("semantic snapshot을 즉시 보내고 waveform을 보충한 뒤 5초 heartbeat와 cleanup을 수행한다", async () => {
    const snapshot = monitor();
    const waveform = {
      artist: "Artist",
      beats: [],
      binCount: 2048,
      bins: [{ high: 0.4, low: 0.2, max: 0.9, mid: 0.3, min: -0.8, peak: 0.9 }],
      cues: [],
      durationMs: 180_000,
      loops: [],
      schemaVersion: 1,
      sections: [],
      title: "Track",
      trackId: "track-1",
      waveformId: "waveform-sha256-1"
    } satisfies DjWaveform;
    const engine = {
      getWaveform: vi.fn(async () => waveform),
      watchMonitor: vi.fn(async function* (
        _sessionId: string,
        options: { signal?: AbortSignal } = {}
      ) {
        yield snapshot;
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      })
    };
    const ingest = {
      cleanup: vi.fn(async () => undefined),
      publicUrl: "https://djscord.example/mix",
      publishSnapshot: vi.fn(async (published: MixSnapshot) => {
        void published;
        return {
          feedId: "feed-1",
          missingWaveformIds: ["waveform-sha256-1"],
          mixUrl: "https://djscord.example/mix?guild=guild-1",
          revision: 1
        };
      }),
      publishWaveform: vi.fn(async () => undefined)
    };
    const publisher = new DjMixPublisher(engine, ingest, {
      bootId: "boot-1",
      heartbeatMs: 20,
      now: () => new Date("2026-08-13T00:01:00Z"),
      terminalGraceMs: 0
    });

    publisher.start({
      guildId: "guild-1",
      ownerRef: "discord:guild:guild-1",
      playlist: { id: "playlist-1", name: "Friday" },
      sessionId: "session-1"
    });
    await vi.waitFor(() => expect(ingest.publishWaveform).toHaveBeenCalledOnce());

    expect(ingest.publishSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      bootId: "boot-1",
      monitor: snapshot,
      ownerRef: "discord:guild:guild-1",
      playlist: { id: "playlist-1", name: "Friday" },
      publisherId: "djscord",
      schemaVersion: 1,
      sequence: 1,
      waveforms: ["waveform-sha256-1"]
    }));
    expect(engine.getWaveform).toHaveBeenCalledWith("track-1");
    expect(ingest.publishWaveform).toHaveBeenCalledWith("waveform-sha256-1", waveform);

    await vi.waitFor(() => expect(ingest.publishSnapshot.mock.calls.length).toBeGreaterThan(1));
    const heartbeat = ingest.publishSnapshot.mock.calls[1]?.[0];
    expect(heartbeat?.capturedAt).toBe("2026-08-13T00:00:00Z");
    expect(heartbeat?.monitor.capturedAt).toBe("2026-08-13T00:00:00Z");
    const sequences = ingest.publishSnapshot.mock.calls.map(([value]) => value.sequence);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));

    await Promise.all([publisher.stop("guild-1"), publisher.stop("guild-1")]);

    expect(ingest.cleanup).toHaveBeenCalledOnce();
    expect(ingest.cleanup).toHaveBeenCalledWith(
      "discord:guild:guild-1",
      expect.objectContaining({ bootId: "boot-1", sequence: expect.any(Number) })
    );
  });

  it("engine waveformId가 monitor와 다르면 잘못된 파형을 업로드하지 않는다", async () => {
    const snapshot = monitor();
    const engine = {
      getWaveform: vi.fn(async () => ({
        artist: "Artist",
        beats: [],
        binCount: 2048 as const,
        bins: [{ high: 0.4, low: 0.2, max: 0.9, mid: 0.3, min: -0.8, peak: 0.9 }],
        cues: [],
        durationMs: 180_000,
        loops: [],
        schemaVersion: 1 as const,
        sections: [],
        title: "Track",
        trackId: "track-1",
        waveformId: "different-waveform"
      })),
      watchMonitor: vi.fn(async function* () {
        yield snapshot;
      })
    };
    const ingest = {
      cleanup: vi.fn(async (ownerRef: string, cleanup: MixCleanup) => {
        void ownerRef;
        void cleanup;
      }),
      publicUrl: "https://djscord.example/mix",
      publishSnapshot: vi.fn(async (published: MixSnapshot) => {
        void published;
        return {
          feedId: "feed-1",
          missingWaveformIds: ["waveform-sha256-1"],
          mixUrl: "https://djscord.example/mix?guild=guild-1",
          revision: 1
        };
      }),
      publishWaveform: vi.fn(async () => undefined)
    };
    const publisher = new DjMixPublisher(engine, ingest, {
      bootId: "boot-1",
      heartbeatMs: 5_000,
      terminalGraceMs: 0
    });

    publisher.start({
      guildId: "guild-1",
      ownerRef: "discord:guild:guild-1",
      playlist: { id: "playlist-1", name: "Friday" },
      sessionId: "session-1"
    });
    await vi.waitFor(() => expect(engine.getWaveform).toHaveBeenCalledOnce());

    expect(ingest.publishWaveform).not.toHaveBeenCalled();
    expect(ingest.publishSnapshot).toHaveBeenCalledOnce();
    await publisher.stop("guild-1");
  });

  it("같은 boot에서 DJ 세션을 다시 시작해도 owner별 sequence를 되돌리지 않는다", async () => {
    const snapshot = monitor();
    const engine = {
      getWaveform: vi.fn(),
      watchMonitor: vi.fn(async function* (
        _sessionId: string,
        options: { signal?: AbortSignal } = {}
      ) {
        yield snapshot;
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      })
    };
    const ingest = {
      cleanup: vi.fn(async (ownerRef: string, cleanup: MixCleanup) => {
        void ownerRef;
        void cleanup;
      }),
      publicUrl: "https://djscord.example/mix",
      publishSnapshot: vi.fn(async (published: MixSnapshot) => {
        void published;
        return {
          feedId: "feed-1",
          missingWaveformIds: [],
          mixUrl: "https://djscord.example/mix?guild=guild-1",
          revision: 1
        };
      }),
      publishWaveform: vi.fn(async () => undefined)
    };
    const publisher = new DjMixPublisher(engine, ingest, {
      bootId: "boot-1",
      terminalGraceMs: 0
    });
    const start = (sessionId: string) => publisher.start({
      guildId: "guild-1",
      ownerRef: "discord:guild:guild-1",
      playlist: { id: "playlist-1", name: "Friday" },
      sessionId
    });

    start("session-1");
    await vi.waitFor(() => expect(ingest.publishSnapshot).toHaveBeenCalledTimes(1));
    await publisher.stop("guild-1");
    const cleanupSequence = ingest.cleanup.mock.calls[0]?.[1].sequence ?? 0;
    const firstSessionPublishCount = ingest.publishSnapshot.mock.calls.length;

    start("session-2");
    await vi.waitFor(() => expect(ingest.publishSnapshot).toHaveBeenCalledTimes(
      firstSessionPublishCount + 1
    ));
    const secondSessionSequence = ingest.publishSnapshot.mock.calls[firstSessionPublishCount]?.[0]
      .sequence ?? 0;

    expect(secondSessionSequence).toBeGreaterThan(cleanupSequence);
    await publisher.stop("guild-1");
  });

  it("선택적인 ingest cleanup 실패 뒤에도 같은 길드 publisher를 다시 시작할 수 있다", async () => {
    const engine = {
      getWaveform: vi.fn(),
      watchMonitor: vi.fn(async function* (
        _sessionId: string,
        options: { signal?: AbortSignal } = {}
      ) {
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      })
    };
    const ingest = {
      cleanup: vi.fn()
        .mockRejectedValueOnce(new Error("ingest unavailable"))
        .mockResolvedValueOnce(undefined),
      publicUrl: "https://djscord.example/mix",
      publishSnapshot: vi.fn(),
      publishWaveform: vi.fn()
    };
    const publisher = new DjMixPublisher(engine, ingest, {
      bootId: "boot-1",
      terminalGraceMs: 0
    });
    const options = {
      guildId: "guild-1",
      ownerRef: "discord:guild:guild-1",
      playlist: { id: "playlist-1", name: "Friday" },
      sessionId: "session-1"
    };
    publisher.start(options);

    await expect(publisher.stop("guild-1")).rejects.toThrow("ingest unavailable");
    expect(() => publisher.start({ ...options, sessionId: "session-2" })).not.toThrow();
    await publisher.stop("guild-1");
  });

  it("monitor EOF와 일시 오류 뒤 지수 backoff로 재구독하고 stop은 대기 중 재연결을 취소한다", async () => {
    vi.useFakeTimers();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const snapshot = monitor();
      let attempt = 0;
      const engine = {
        getWaveform: vi.fn(),
        watchMonitor: vi.fn(async function* () {
          attempt += 1;
          if (attempt === 2) throw new Error("temporary monitor failure");
          yield snapshot;
        })
      };
      const ingest = {
        cleanup: vi.fn(async () => undefined),
        publicUrl: "https://djscord.example/mix",
        publishSnapshot: vi.fn(async () => ({
          feedId: "feed-1",
          missingWaveformIds: [],
          mixUrl: "https://djscord.example/mix?guild=guild-1",
          revision: 1
        })),
        publishWaveform: vi.fn(async () => undefined)
      };
      const publisher = new DjMixPublisher(engine, ingest, {
        bootId: "boot-1",
        heartbeatMs: 50,
        terminalGraceMs: 0
      });

      publisher.start({
        guildId: "guild-1",
        ownerRef: "discord:guild:guild-1",
        playlist: { id: "playlist-1", name: "Friday" },
        sessionId: "session-1"
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(engine.watchMonitor).toHaveBeenCalledTimes(1);
      expect(ingest.publishSnapshot).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(50);
      expect(ingest.publishSnapshot).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(199);
      expect(engine.watchMonitor).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(engine.watchMonitor).toHaveBeenCalledTimes(2);
      expect(errorLog).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(499);
      expect(engine.watchMonitor).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(engine.watchMonitor).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(249);
      expect(engine.watchMonitor).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(engine.watchMonitor).toHaveBeenCalledTimes(4);

      await publisher.stop("guild-1");
      const subscriptionsAfterStop = engine.watchMonitor.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);

      expect(engine.watchMonitor).toHaveBeenCalledTimes(subscriptionsAfterStop);
      expect(ingest.cleanup).toHaveBeenCalledOnce();
    } finally {
      errorLog.mockRestore();
      vi.useRealTimers();
    }
  });

  it("ingest가 느려도 heartbeat snapshot은 최신 한 건으로 합쳐 backlog를 만들지 않는다", async () => {
    vi.useFakeTimers();
    try {
      const snapshot = monitor();
      let releaseFirst: (() => void) | undefined;
      const engine = {
        getWaveform: vi.fn(),
        watchMonitor: vi.fn(async function* (
          _sessionId: string,
          options: { signal?: AbortSignal } = {}
        ) {
          yield snapshot;
          await new Promise<void>((resolve) => {
            options.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        })
      };
      const ingest = {
        cleanup: vi.fn(async () => undefined),
        publicUrl: "https://djscord.example/mix",
        publishSnapshot: vi.fn()
          .mockImplementationOnce(() => new Promise((resolve) => {
            releaseFirst = () => resolve({
              feedId: "feed-1",
              missingWaveformIds: [],
              mixUrl: "https://djscord.example/mix?guild=guild-1",
              revision: 1
            });
          }))
          .mockResolvedValue({
            feedId: "feed-1",
            missingWaveformIds: [],
            mixUrl: "https://djscord.example/mix?guild=guild-1",
            revision: 2
          }),
        publishWaveform: vi.fn(async () => undefined)
      };
      const publisher = new DjMixPublisher(engine, ingest, {
        bootId: "boot-1",
        heartbeatMs: 5,
        terminalGraceMs: 0
      });
      publisher.start({
        guildId: "guild-1",
        ownerRef: "discord:guild:guild-1",
        playlist: { id: "playlist-1", name: "Friday" },
        sessionId: "session-1"
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(ingest.publishSnapshot).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(100);
      expect(ingest.publishSnapshot).toHaveBeenCalledOnce();
      releaseFirst?.();
      await vi.advanceTimersByTimeAsync(0);

      expect(ingest.publishSnapshot).toHaveBeenCalledTimes(2);
      await publisher.stop("guild-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop은 짧은 grace 동안 terminal monitor를 cleanup보다 먼저 게시한다", async () => {
    const ready = monitor();
    const finished = {
      ...ready,
      capturedAt: "2026-08-13T00:02:00Z",
      playing: false,
      revision: 2,
      status: "finished" as const
    };
    let releaseTerminal: (() => void) | undefined;
    const engine = {
      getWaveform: vi.fn(),
      watchMonitor: vi.fn(async function* () {
        yield ready;
        await new Promise<void>((resolve) => {
          releaseTerminal = resolve;
        });
        yield finished;
      })
    };
    const calls: string[] = [];
    const ingest = {
      cleanup: vi.fn(async () => {
        calls.push("cleanup");
      }),
      publicUrl: "https://djscord.example/mix",
      publishSnapshot: vi.fn(async (snapshot: MixSnapshot) => {
        calls.push(`snapshot:${snapshot.monitor.status}`);
        return {
          feedId: "feed-1",
          missingWaveformIds: [],
          mixUrl: "https://djscord.example/mix?guild=guild-1",
          revision: snapshot.sequence
        };
      }),
      publishWaveform: vi.fn(async () => undefined)
    };
    const publisher = new DjMixPublisher(engine, ingest, {
      bootId: "boot-1",
      terminalGraceMs: 1_000
    });

    publisher.start({
      guildId: "guild-1",
      ownerRef: "discord:guild:guild-1",
      playlist: { id: "playlist-1", name: "Friday" },
      sessionId: "session-1"
    });
    await vi.waitFor(() => expect(ingest.publishSnapshot).toHaveBeenCalledOnce());

    const stopping = publisher.stop("guild-1");
    await Promise.resolve();
    expect(ingest.cleanup).not.toHaveBeenCalled();
    releaseTerminal?.();
    await stopping;

    expect(calls).toEqual(["snapshot:ready", "snapshot:finished", "cleanup"]);
  });

  it("terminal frame 없이 stop해도 종료 snapshot을 합성해 cleanup 전에 게시한다", async () => {
    const ready = monitor();
    const engine = {
      getWaveform: vi.fn(),
      watchMonitor: vi.fn(async function* (
        _sessionId: string,
        options: { signal?: AbortSignal } = {}
      ) {
        yield ready;
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      })
    };
    const calls: string[] = [];
    const ingest = {
      cleanup: vi.fn(async () => {
        calls.push("cleanup");
      }),
      publicUrl: "https://djscord.example/mix",
      publishSnapshot: vi.fn(async (snapshot: MixSnapshot) => {
        calls.push(`snapshot:${snapshot.monitor.status}`);
        return {
          feedId: "feed-1",
          missingWaveformIds: [],
          mixUrl: "https://djscord.example/mix?guild=guild-1",
          revision: snapshot.sequence
        };
      }),
      publishWaveform: vi.fn(async () => undefined)
    };
    const publisher = new DjMixPublisher(engine, ingest, {
      bootId: "boot-1",
      now: () => new Date("2026-08-13T00:03:00Z"),
      terminalGraceMs: 0
    });

    publisher.start({
      guildId: "guild-1",
      ownerRef: "discord:guild:guild-1",
      playlist: { id: "playlist-1", name: "Friday" },
      sessionId: "session-1"
    });
    await vi.waitFor(() => expect(ingest.publishSnapshot).toHaveBeenCalledOnce());
    await publisher.stop("guild-1");

    const terminal = ingest.publishSnapshot.mock.calls[1]?.[0].monitor as
      | DjMonitorSnapshot
      | undefined;
    expect(terminal).toMatchObject({
      capturedAt: "2026-08-13T00:03:00.000Z",
      master: { peakLeft: 0, peakRight: 0 },
      playing: false,
      status: "finished"
    });
    expect(terminal?.decks.a?.state).toBe("paused");
    expect(calls).toEqual(["snapshot:ready", "snapshot:finished", "cleanup"]);
  });

  it("terminal grace는 설정된 상한만 대기하고 사용자 종료를 무한히 지연하지 않는다", async () => {
    vi.useFakeTimers();
    try {
      const ready = monitor();
      const engine = {
        getWaveform: vi.fn(),
        watchMonitor: vi.fn(async function* (
          _sessionId: string,
          options: { signal?: AbortSignal } = {}
        ) {
          yield ready;
          await new Promise<void>((resolve) => {
            options.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        })
      };
      const ingest = {
        cleanup: vi.fn(async () => undefined),
        publicUrl: "https://djscord.example/mix",
        publishSnapshot: vi.fn(async (snapshot: MixSnapshot) => snapshotResult(snapshot.sequence)),
        publishWaveform: vi.fn(async () => undefined)
      };
      const publisher = new DjMixPublisher(engine, ingest, {
        bootId: "boot-1",
        terminalGraceMs: 200
      });
      publisher.start({
        guildId: "guild-1",
        ownerRef: "discord:guild:guild-1",
        playlist: { id: "playlist-1", name: "Friday" },
        sessionId: "session-1"
      });
      await vi.advanceTimersByTimeAsync(0);

      const stopping = publisher.stop("guild-1");
      await vi.advanceTimersByTimeAsync(199);
      expect(ingest.cleanup).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await stopping;

      expect(ingest.cleanup).toHaveBeenCalledOnce();
      const lastMonitor = ingest.publishSnapshot.mock.calls.at(-1)?.[0].monitor as
        | DjMonitorSnapshot
        | undefined;
      expect(lastMonitor?.status).toBe("finished");
    } finally {
      vi.useRealTimers();
    }
  });
});
