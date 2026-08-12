import { readFileSync } from "node:fs";

import {
  DEFAULT_HEARTBEAT_MAX_AGE_MS,
  DEFAULT_HEARTBEAT_PATH,
  evaluateHeartbeat
} from "./health/heartbeat.js";

const path = process.env.HEALTHCHECK_PATH ?? DEFAULT_HEARTBEAT_PATH;
const configuredMaximumAge = Number(process.env.HEALTHCHECK_MAX_AGE_MS);
const maximumAgeMs =
  Number.isSafeInteger(configuredMaximumAge) && configuredMaximumAge > 0
    ? configuredMaximumAge
    : DEFAULT_HEARTBEAT_MAX_AGE_MS;

let raw: string;
try {
  raw = readFileSync(path, "utf8");
} catch {
  console.error("봇 상태 파일이 아직 생성되지 않았습니다.");
  process.exitCode = 1;
  process.exit();
}

const evaluation = evaluateHeartbeat(raw, Date.now(), maximumAgeMs);
if (!evaluation.ok) {
  console.error(evaluation.reason);
  process.exitCode = 1;
}
