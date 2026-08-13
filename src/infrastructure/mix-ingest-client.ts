import { createHmac, randomUUID } from "node:crypto";

import type { DjMonitorSnapshot, DjWaveform } from "./djengine-client.js";

export interface MixSnapshot {
  bootId: string;
  capturedAt: string;
  monitor: DjMonitorSnapshot | Record<string, unknown>;
  ownerRef: string;
  playlist: { id: string; name: string };
  publisherId: "djscord";
  schemaVersion: 1;
  sequence: number;
  waveforms: readonly string[];
}

export interface MixCleanup {
  bootId: string;
  capturedAt: string;
  sequence: number;
}

export interface MixIngestResult {
  feedId: string;
  missingWaveformIds: string[];
  mixUrl: string;
  revision: number;
}

export interface MixGuild {
  icon: string | null;
  id: string;
  name: string;
}

export type MixWaveform = DjWaveform & { waveformId: string };

interface MixIngestClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  nonce?: () => string;
  now?: () => Date;
  publicUrl: string;
  secret: string;
}

interface IngestEnvelope {
  data: MixIngestResult;
}

export class MixIngestClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #nonce: () => string;
  readonly #now: () => Date;
  readonly publicUrl: string;
  readonly #secret: string;

  constructor(options: MixIngestClientOptions) {
    if (new TextEncoder().encode(options.secret).length < 32) {
      throw new Error("MIX_INGEST_SECRET은 32바이트 이상이어야 합니다.");
    }
    this.#baseUrl = validateHttpsUrl(options.baseUrl, "MIX_INGEST_URL");
    this.publicUrl = validateHttpsUrl(options.publicUrl, "MIX_PUBLIC_URL");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#nonce = options.nonce ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#secret = options.secret;
  }

  async publishSnapshot(snapshot: MixSnapshot): Promise<MixIngestResult> {
    assertOwnerRef(snapshot.ownerRef);
    for (const waveformId of snapshot.waveforms) assertWaveformId(waveformId);
    const response = await this.#request("snapshots", "POST", snapshot);
    const envelope = await response.json() as IngestEnvelope;
    return envelope.data;
  }

  async publishWaveform(
    waveformId: string,
    waveform: MixWaveform | Record<string, unknown>
  ): Promise<void> {
    assertWaveformId(waveformId);
    if (waveform.waveformId !== waveformId) {
      throw new Error("waveformId path와 body가 일치해야 합니다.");
    }
    await this.#request(`waveforms/${encodeURIComponent(waveformId)}`, "PUT", waveform);
  }

  async cleanup(ownerRef: string, cleanup: MixCleanup): Promise<void> {
    assertOwnerRef(ownerRef);
    await this.#request(`snapshots/${encodeURIComponent(ownerRef)}`, "DELETE", cleanup);
  }

  async syncGuilds(guilds: MixGuild[]): Promise<void> {
    await this.#request("guilds", "PUT", {
      capturedAt: this.#now().toISOString(),
      guilds,
      publisherId: "djscord",
      schemaVersion: 1
    });
  }

  async #request(path: string, method: string, payload: unknown): Promise<Response> {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(this.#now().getTime() / 1_000).toString();
    const nonce = this.#nonce();
    const canonical = `${timestamp}.${nonce}.${body}`;
    const signature = createHmac("sha256", this.#secret).update(canonical).digest("hex");
    const response = await this.#fetch(`${this.#baseUrl}/${path}`, {
      body,
      headers: {
        "Content-Type": "application/json",
        "X-Djscord-Key-Id": "djscord",
        "X-Djscord-Nonce": nonce,
        "X-Djscord-Signature": `v1=${signature}`,
        "X-Djscord-Timestamp": timestamp
      },
      method,
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      throw new Error(`mix ingest 요청에 실패했습니다. (${response.status})`);
    }
    return response;
  }
}

function assertOwnerRef(value: string): void {
  if (!/^discord:guild:\d{15,22}$/u.test(value)) {
    throw new Error("ownerRef는 Discord guild 형식이어야 합니다.");
  }
}

function assertWaveformId(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("waveformId는 소문자 SHA-256 형식이어야 합니다.");
  }
}

function validateHttpsUrl(value: string, name: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${name}은 인증 정보가 없는 HTTPS 주소여야 합니다.`);
  }
  return url.toString().replace(/\/$/u, "");
}
