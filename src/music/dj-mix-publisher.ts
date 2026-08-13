import { randomUUID } from "node:crypto";

import type {
  DjMonitorSnapshot,
  DjWaveform
} from "../infrastructure/djengine-client.js";
import type {
  MixCleanup,
  MixIngestResult,
  MixSnapshot,
  MixWaveform
} from "../infrastructure/mix-ingest-client.js";

interface DjMonitorPort {
  getWaveform(trackId: string): Promise<DjWaveform>;
  watchMonitor(
    sessionId: string,
    options?: { signal?: AbortSignal }
  ): AsyncIterable<DjMonitorSnapshot>;
}

interface MixIngestPort {
  cleanup(ownerRef: string, cleanup: MixCleanup): Promise<void>;
  publicUrl: string;
  publishSnapshot(snapshot: MixSnapshot): Promise<MixIngestResult>;
  publishWaveform(waveformId: string, waveform: MixWaveform): Promise<void>;
}

interface PublisherOptions {
  bootId?: string;
  heartbeatMs?: number;
  now?: () => Date;
  terminalGraceMs?: number;
}

interface StartMixPublisherOptions {
  guildId: string;
  ownerRef: string;
  playlist: { id: string; name: string };
  sessionId: string;
}

interface ActivePublisher extends StartMixPublisherOptions {
  abortController: AbortController;
  cleanup?: Promise<void>;
  heartbeat?: NodeJS.Timeout;
  lastMonitor?: DjMonitorSnapshot;
  pending: Promise<void>;
  publishing: boolean;
  queuedMonitor?: DjMonitorSnapshot;
  resolveTerminal: () => void;
  sequence: number;
  terminal: Promise<void>;
  terminalSeen: boolean;
  uploadedWaveforms: Set<string>;
}

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;

export class DjMixPublisher {
  readonly #active = new Map<string, ActivePublisher>();
  readonly #bootId: string;
  readonly #engine: DjMonitorPort;
  readonly #heartbeatMs: number;
  readonly #ingest: MixIngestPort;
  readonly #now: () => Date;
  readonly #ownerSequences = new Map<string, number>();
  readonly #terminalGraceMs: number;

  constructor(engine: DjMonitorPort, ingest: MixIngestPort, options: PublisherOptions = {}) {
    this.#engine = engine;
    this.#ingest = ingest;
    this.#bootId = options.bootId ?? randomUUID();
    this.#heartbeatMs = options.heartbeatMs ?? 5_000;
    this.#now = options.now ?? (() => new Date());
    this.#terminalGraceMs = options.terminalGraceMs ?? 1_000;
    if (!Number.isSafeInteger(this.#terminalGraceMs) || this.#terminalGraceMs < 0) {
      throw new Error("mix terminal grace는 0 이상이어야 합니다.");
    }
  }

  start(options: StartMixPublisherOptions): void {
    if (this.#active.has(options.guildId)) {
      throw new Error("이 서버의 mix publisher가 이미 실행 중입니다.");
    }
    let resolveTerminal: () => void = () => undefined;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const active: ActivePublisher = {
      ...options,
      abortController: new AbortController(),
      pending: Promise.resolve(),
      publishing: false,
      resolveTerminal,
      sequence: this.#ownerSequences.get(options.ownerRef) ?? 0,
      terminal,
      terminalSeen: false,
      uploadedWaveforms: new Set()
    };
    this.#active.set(options.guildId, active);
    active.heartbeat = setInterval(() => {
      if (active.lastMonitor !== undefined) {
        this.#enqueueSnapshot(active, active.lastMonitor);
      }
    }, this.#heartbeatMs);
    active.heartbeat.unref();
    void this.#consume(active);
  }

  getMixUrl(guildId: string): string {
    const url = new URL(this.#ingest.publicUrl);
    url.searchParams.set("guild", guildId);
    return url.toString();
  }

  stop(guildId: string): Promise<void> {
    const active = this.#active.get(guildId);
    if (active === undefined) return Promise.resolve();
    if (active.cleanup !== undefined) return active.cleanup;
    active.cleanup = waitForTerminal(active, this.#terminalGraceMs)
      .then(async () => {
        if (active.heartbeat !== undefined) clearInterval(active.heartbeat);
        active.abortController.abort();
        if (!active.terminalSeen && active.lastMonitor !== undefined) {
          this.#enqueueSnapshot(active, terminalSnapshot(active.lastMonitor, this.#now()));
        }
        await drainSnapshots(active);
      })
      .then(() => this.#ingest.cleanup(active.ownerRef, {
        bootId: this.#bootId,
        capturedAt: this.#now().toISOString(),
        sequence: this.#nextSequence(active)
      }))
      .then(() => {
        if (this.#active.get(guildId) === active) this.#active.delete(guildId);
      })
      .catch((error: unknown) => {
        // 웹 feed는 heartbeat가 끊기면 만료됩니다. 선택 기능의 cleanup 장애가
        // 다음 DJ 오디오 세션까지 막지 않도록 로컬 소유권은 해제합니다.
        if (this.#active.get(guildId) === active) this.#active.delete(guildId);
        throw error;
      });
    return active.cleanup;
  }

  async stopAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#active.keys()].map((guildId) => this.stop(guildId))
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "mix publisher 정리에 실패했습니다.");
    }
  }

  async #consume(active: ActivePublisher): Promise<void> {
    let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    while (!active.abortController.signal.aborted) {
      try {
        for await (const monitor of this.#engine.watchMonitor(active.sessionId, {
          signal: active.abortController.signal
        })) {
          if (active.abortController.signal.aborted) return;
          const semantic = active.lastMonitor === undefined || isSemanticChange(active.lastMonitor, monitor);
          reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
          active.lastMonitor = monitor;
          if (semantic) this.#enqueueSnapshot(active, monitor);
          if (monitor.status === "finished" || monitor.status === "failed") {
            active.terminalSeen = true;
            active.resolveTerminal();
          }
        }
      } catch (error) {
        if (active.abortController.signal.aborted) return;
        console.error(`DJ mix monitor 연결이 종료되었습니다: guild=${active.guildId}`, error);
      }

      if (active.abortController.signal.aborted) return;
      try {
        await abortableDelay(reconnectDelayMs, active.abortController.signal);
      } catch {
        return;
      }
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    }
  }

  #enqueueSnapshot(active: ActivePublisher, monitor: DjMonitorSnapshot): void {
    active.queuedMonitor = monitor;
    if (active.publishing) return;
    active.publishing = true;
    active.pending = active.pending
      .catch(() => undefined)
      .then(async () => {
        while (active.queuedMonitor !== undefined) {
          const latest = active.queuedMonitor;
          delete active.queuedMonitor;
          await this.#publishSnapshot(active, latest);
        }
      })
      .finally(() => {
        active.publishing = false;
        if (active.queuedMonitor !== undefined) {
          this.#enqueueSnapshot(active, active.queuedMonitor);
        }
      });
  }

  async #publishSnapshot(active: ActivePublisher, monitor: DjMonitorSnapshot): Promise<void> {
    const waveformReferences = waveformRefs(monitor);
    const waveforms = waveformReferences.map(({ waveformId }) => waveformId);
    const result = await this.#ingest.publishSnapshot({
      bootId: this.#bootId,
      capturedAt: monitor.capturedAt,
      monitor,
      ownerRef: active.ownerRef,
      playlist: active.playlist,
      publisherId: "djscord",
      schemaVersion: 1,
      sequence: this.#nextSequence(active),
      waveforms
    });
    await Promise.allSettled(
      result.missingWaveformIds
        .flatMap((waveformId) => {
          const reference = waveformReferences.find(
            (candidate) => candidate.waveformId === waveformId
          );
          return reference === undefined ? [] : [this.#uploadWaveform(active, reference)];
        })
    );
  }

  async #uploadWaveform(
    active: ActivePublisher,
    reference: { trackId: string; waveformId: string }
  ): Promise<void> {
    if (active.uploadedWaveforms.has(reference.waveformId)) return;
    const waveform = await this.#engine.getWaveform(reference.trackId);
    if (waveform.waveformId !== reference.waveformId) {
      throw new Error(
        `DJ Engine waveformId가 monitor와 일치하지 않습니다. (${reference.trackId})`
      );
    }
    const upload: MixWaveform = waveform;
    await this.#ingest.publishWaveform(reference.waveformId, upload);
    active.uploadedWaveforms.add(reference.waveformId);
  }

  #nextSequence(active: ActivePublisher): number {
    active.sequence += 1;
    this.#ownerSequences.set(active.ownerRef, active.sequence);
    return active.sequence;
  }
}

function waveformRefs(
  snapshot: DjMonitorSnapshot
): { trackId: string; waveformId: string }[] {
  const references = [snapshot.decks.a, snapshot.decks.b].flatMap((deck) =>
    deck?.waveformId === null || deck === null
      ? []
      : [{ trackId: deck.trackId, waveformId: deck.waveformId }]
  );
  return references.filter(
    (reference, index) =>
      references.findIndex(({ waveformId }) => waveformId === reference.waveformId) === index
  );
}

function isSemanticChange(previous: DjMonitorSnapshot, next: DjMonitorSnapshot): boolean {
  return (
    previous.status !== next.status ||
    previous.playing !== next.playing ||
    previous.decks.a?.trackId !== next.decks.a?.trackId ||
    previous.decks.b?.trackId !== next.decks.b?.trackId ||
    previous.decks.a?.waveformId !== next.decks.a?.waveformId ||
    previous.decks.b?.waveformId !== next.decks.b?.waveformId ||
    previous.decks.a?.state !== next.decks.a?.state ||
    previous.decks.b?.state !== next.decks.b?.state ||
    previous.transition?.style !== next.transition?.style ||
    (previous.transition === null) !== (next.transition === null)
  );
}

function terminalSnapshot(snapshot: DjMonitorSnapshot, now: Date): DjMonitorSnapshot {
  const pauseDeck = (deck: DjMonitorSnapshot["decks"]["a"]) =>
    deck === null ? null : { ...deck, state: "paused" as const };
  return {
    ...snapshot,
    capturedAt: now.toISOString(),
    decks: {
      a: pauseDeck(snapshot.decks.a),
      b: pauseDeck(snapshot.decks.b)
    },
    master: { peakLeft: 0, peakRight: 0 },
    playing: false,
    revision: snapshot.revision + 1,
    status: "finished",
    transition: null
  };
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
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

async function waitForTerminal(active: ActivePublisher, graceMs: number): Promise<void> {
  if (active.terminalSeen || graceMs === 0) return;
  await Promise.race([
    active.terminal,
    new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, graceMs);
      timeout.unref();
    })
  ]);
}

async function drainSnapshots(active: ActivePublisher): Promise<void> {
  while (true) {
    const pending = active.pending;
    await pending.catch(() => undefined);
    if (
      active.pending === pending &&
      !active.publishing &&
      active.queuedMonitor === undefined
    ) {
      return;
    }
  }
}
