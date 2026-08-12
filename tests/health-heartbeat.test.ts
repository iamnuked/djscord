import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateHeartbeat,
  HealthHeartbeat,
  type HeartbeatSnapshot
} from "../src/health/heartbeat.js";

describe("evaluateHeartbeat", () => {
  const ready: HeartbeatSnapshot = {
    pid: 42,
    status: "ready",
    updatedAtMs: 10_000
  };

  it("accepts a fresh ready heartbeat", () => {
    expect(evaluateHeartbeat(JSON.stringify(ready), 20_000, 15_000)).toEqual({ ok: true });
  });

  it("rejects a heartbeat when Discord or Lavalink is not ready", () => {
    expect(
      evaluateHeartbeat(
        JSON.stringify({ ...ready, status: "degraded" }),
        20_000,
        15_000
      )
    ).toEqual({ ok: false, reason: "봇 연결이 준비되지 않았습니다." });
  });

  it("rejects a stale heartbeat", () => {
    expect(evaluateHeartbeat(JSON.stringify(ready), 30_001, 20_000)).toEqual({
      ok: false,
      reason: "봇 상태 신호가 만료되었습니다."
    });
  });

  it("rejects malformed heartbeat data without throwing", () => {
    expect(evaluateHeartbeat("not-json", 20_000, 15_000)).toEqual({
      ok: false,
      reason: "봇 상태 파일을 읽을 수 없습니다."
    });
  });
});

describe("HealthHeartbeat", () => {
  it("updates the file from degraded to ready and records shutdown", () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), "djscord-health-"));
    const path = join(directory, "health.json");
    let ready = false;
    let now = 1_000;
    const heartbeat = new HealthHeartbeat({
      intervalMs: 5_000,
      isReady: () => ready,
      now: () => now,
      path,
      pid: 99
    });

    try {
      heartbeat.start();
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        pid: 99,
        status: "degraded",
        updatedAtMs: 1_000
      });

      ready = true;
      now = 6_000;
      vi.advanceTimersByTime(5_000);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        pid: 99,
        status: "ready",
        updatedAtMs: 6_000
      });

      now = 7_000;
      heartbeat.stop();
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        pid: 99,
        status: "stopping",
        updatedAtMs: 7_000
      });
    } finally {
      vi.useRealTimers();
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
