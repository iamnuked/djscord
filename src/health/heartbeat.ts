import {
  mkdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_HEARTBEAT_PATH = "/tmp/djscord-health.json";
export const DEFAULT_HEARTBEAT_MAX_AGE_MS = 45_000;

export type HeartbeatStatus = "degraded" | "ready" | "stopping";

export interface HeartbeatSnapshot {
  pid: number;
  status: HeartbeatStatus;
  updatedAtMs: number;
}

export type HeartbeatEvaluation =
  | { ok: true }
  | { ok: false; reason: string };

export function evaluateHeartbeat(
  raw: string,
  nowMs: number,
  maximumAgeMs: number
): HeartbeatEvaluation {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isHeartbeatSnapshot(value)) {
      return { ok: false, reason: "봇 상태 파일을 읽을 수 없습니다." };
    }
    if (value.status !== "ready") {
      return { ok: false, reason: "봇 연결이 준비되지 않았습니다." };
    }
    if (nowMs - value.updatedAtMs > maximumAgeMs) {
      return { ok: false, reason: "봇 상태 신호가 만료되었습니다." };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "봇 상태 파일을 읽을 수 없습니다." };
  }
}

interface HealthHeartbeatOptions {
  intervalMs?: number;
  isReady: () => boolean;
  now?: () => number;
  path?: string;
  pid?: number;
}

export class HealthHeartbeat {
  readonly #intervalMs: number;
  readonly #isReady: () => boolean;
  readonly #now: () => number;
  readonly #path: string;
  readonly #pid: number;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: HealthHeartbeatOptions) {
    this.#intervalMs = options.intervalMs ?? 10_000;
    this.#isReady = options.isReady;
    this.#now = options.now ?? Date.now;
    this.#path = options.path ?? DEFAULT_HEARTBEAT_PATH;
    this.#pid = options.pid ?? process.pid;
  }

  start(): void {
    if (this.#timer !== undefined) {
      return;
    }
    this.refresh();
    this.#timer = setInterval(() => this.refresh(), this.#intervalMs);
    this.#timer.unref();
  }

  refresh(): void {
    this.#write(this.#isReady() ? "ready" : "degraded");
  }

  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#write("stopping");
  }

  #write(status: HeartbeatStatus): void {
    const snapshot: HeartbeatSnapshot = {
      pid: this.#pid,
      status,
      updatedAtMs: this.#now()
    };
    const temporaryPath = `${this.#path}.${this.#pid}.tmp`;
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, this.#path);
  }
}

function isHeartbeatSnapshot(value: unknown): value is HeartbeatSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<HeartbeatSnapshot>;
  return (
    Number.isSafeInteger(candidate.pid) &&
    typeof candidate.updatedAtMs === "number" &&
    Number.isFinite(candidate.updatedAtMs) &&
    (candidate.status === "degraded" ||
      candidate.status === "ready" ||
      candidate.status === "stopping")
  );
}
