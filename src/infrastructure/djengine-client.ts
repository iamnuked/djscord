export type DjEnergyProfile = "flat" | "warmup" | "build" | "peak" | "cooldown";
export type DjSessionStatus = "preparing" | "ready" | "paused" | "finished" | "failed";
export type DjCommandType = "play" | "pause" | "skip";

export interface DjPlaylist {
  id: string;
  name: string;
  path: string;
}

export interface DjSessionView {
  createdAt: string;
  currentTrackId: string | null;
  id: string;
  ownerRef?: string | null;
  playlistId: string;
  status: DjSessionStatus;
}

export interface DjSession extends DjSessionView {
  audioUrl: string;
  energyProfile: DjEnergyProfile;
}

export interface CreateDjSessionInput {
  energyProfile?: DjEnergyProfile;
  idempotencyKey?: string;
  maxDurationMinutes?: number;
  ownerRef?: string;
  playlistId: string;
  seed?: number;
}

export interface DjScheduledCommand {
  commandId: string;
  quantize: "immediate" | "next_beat" | "next_bar" | "next_phrase";
  scheduledSample: number;
  type: DjCommandType;
}

export interface DjEngineEvent {
  at: string;
  data: unknown;
  event: string;
  id: number;
}

export type DjDeckSlot = "a" | "b";

export interface DjMonitorDeck {
  artist: string;
  durationMs: number;
  gains: { high: number; low: number; mid: number };
  loop: { endMs: number; startMs: number } | null;
  musicalKey: string | null;
  playbackBpm: number;
  positionMs: number;
  sourceRate: number;
  state: "playing" | "paused" | "cued" | "mixing";
  title: string;
  trackId: string;
  waveformId: string | null;
}

export interface DjMonitorSnapshot {
  capturedAt: string;
  decks: { a: DjMonitorDeck | null; b: DjMonitorDeck | null };
  master: { peakLeft: number; peakRight: number };
  outputSample: number;
  playing: boolean;
  revision: number;
  sampleRate: 48_000;
  schemaVersion: 1;
  sessionId: string;
  status: DjSessionStatus;
  transition: {
    bassSwapAt: number;
    bassSwapProgress: number;
    durationBars: number;
    durationMs: number;
    fromDeck: DjDeckSlot;
    progress: number;
    style: "eq_blend" | "loop_blend" | "phrase_cut" | "echo_cut" | "hard_cut";
    toDeck: DjDeckSlot;
  } | null;
}

export interface DjWaveform {
  artist: string;
  beats: { beatInBar: number; positionMs: number }[];
  binCount: 2_048;
  bins: { high: number; low: number; max: number; mid: number; min: number; peak: number }[];
  cues: { positionMs: number }[];
  durationMs: number;
  loops: { endMs: number; name: string; startMs: number }[];
  schemaVersion: 1;
  sections: {
    confidence: number;
    endMs: number;
    energy: number;
    kind: "intro" | "verse" | "breakdown" | "buildup" | "drop" | "chorus" | "bridge" | "outro";
    startMs: number;
  }[];
  title: string;
  trackId: string;
  waveformId: string;
}

interface ClientOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
}

interface Envelope<T> {
  data: T;
}

interface CollectionEnvelope<T> {
  data: T[];
  meta: { hasNext: boolean; nextCursor: string | null };
}

interface ErrorEnvelope {
  error?: { code?: string; details?: unknown; message?: string };
  requestId?: string;
}

export class DjEngineError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;
  readonly status: number;

  constructor(status: number, envelope: ErrorEnvelope) {
    const code = safeExternalIdentifier(envelope.error?.code, 64) ?? "unknown_error";
    super(`DJ Engine 요청에 실패했습니다. (${code})`);
    this.name = "DjEngineError";
    this.status = status;
    this.code = code;
    const requestId = safeExternalIdentifier(envelope.requestId, 128);
    if (requestId !== undefined) this.requestId = requestId;
    // 외부 오류의 details에는 capability token이 포함될 수 있으므로 원문을 보관하지 않습니다.
    if (envelope.error?.details !== undefined) this.details = "민감 정보 보호를 위해 생략됨";
  }
}

export class DjEngineClient {
  static readonly MAX_EVENT_BUFFER_BYTES = 65_536;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #pollIntervalMs: number;
  readonly #requestTimeoutMs: number;

  constructor(options: ClientOptions) {
    if (new TextEncoder().encode(options.apiKey).length < 32) {
      throw new Error("DJENGINE_API_KEY는 32바이트 이상이어야 합니다.");
    }
    const url = new URL(options.baseUrl);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("DJENGINE_BASE_URL은 안전한 HTTP(S) 주소여야 합니다.");
    }
    this.#apiKey = options.apiKey;
    this.#baseUrl = url.toString().replace(/\/$/u, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#pollIntervalMs = options.pollIntervalMs ?? 250;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  async listPlaylists(): Promise<DjPlaylist[]> {
    const playlists: DjPlaylist[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor !== undefined) query.set("cursor", cursor);
      const result = await this.#request<CollectionEnvelope<DjPlaylist>>(
        `/api/v1/playlists?${query.toString()}`
      );
      playlists.push(...result.data);
      cursor = result.meta.hasNext && result.meta.nextCursor !== null
        ? result.meta.nextCursor
        : undefined;
    } while (cursor !== undefined);
    return playlists;
  }

  async createSession(input: CreateDjSessionInput): Promise<DjSession> {
    const { idempotencyKey, ...body } = input;
    const headers: Record<string, string> = {};
    if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
    const envelope = await this.#request<Envelope<DjSession>>("/api/v1/sessions", {
      body: JSON.stringify(body),
      headers,
      method: "POST"
    });
    try {
      return { ...envelope.data, audioUrl: this.#validateAudioUrl(envelope.data) };
    } catch (error) {
      await this.closeSession(envelope.data.id).catch(() => undefined);
      throw error;
    }
  }

  async waitUntilReady(
    sessionId: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<DjSessionView> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      const requestTimeoutMs = Math.max(
        1,
        Math.min(this.#requestTimeoutMs, deadline - Date.now())
      );
      const requestSignal = options.signal === undefined
        ? AbortSignal.timeout(requestTimeoutMs)
        : AbortSignal.any([
            options.signal,
            AbortSignal.timeout(requestTimeoutMs)
          ]);
      const envelope = await this.#request<Envelope<DjSessionView>>(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
        { signal: requestSignal }
      );
      const session = envelope.data;
      if (session.status === "ready") return session;
      if (session.status === "failed" || session.status === "finished") {
        throw new Error(`DJ Engine 세션 준비에 실패했습니다. (${session.status})`);
      }
      await abortableDelay(
        Math.min(this.#pollIntervalMs, Math.max(0, deadline - Date.now())),
        options.signal
      );
    }
    throw new Error("DJ Engine 세션 준비 시간이 초과되었습니다. (timeout)");
  }

  async sendCommand(
    sessionId: string,
    commandId: string,
    command: DjCommandType | { type: DjCommandType },
    quantize: DjScheduledCommand["quantize"] = "next_bar"
  ): Promise<DjScheduledCommand> {
    const type = typeof command === "string" ? command : command.type;
    const envelope = await this.#request<Envelope<DjScheduledCommand>>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/commands`,
      {
        body: JSON.stringify({ commandId, quantize, type }),
        method: "POST"
      }
    );
    return envelope.data;
  }

  async closeSession(sessionId: string): Promise<void> {
    const response = await this.#raw(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
      true
    );
    if (response.ok || response.status === 404) return;
    await this.#throwApiError(response);
  }

  async getWaveform(trackId: string): Promise<DjWaveform> {
    const envelope = await this.#request<Envelope<DjWaveform>>(
      `/api/v1/tracks/${encodeURIComponent(trackId)}/waveform`
    );
    return envelope.data;
  }

  async *watchMonitor(
    sessionId: string,
    options: { signal?: AbortSignal } = {}
  ): AsyncGenerator<DjMonitorSnapshot> {
    const response = await this.#openEventStream(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/monitor`,
      options.signal
    );
    for await (const block of this.#eventBlocks(response)) {
      const event = block
        .split("\n")
        .find((line) => line.startsWith("event:"))
        ?.slice(6)
        .trim();
      if (event !== "mix.monitor.v1") continue;
      const data = extractEventData(block);
      if (data !== "") yield JSON.parse(data) as DjMonitorSnapshot;
    }
  }

  async *watchEvents(
    sessionId: string,
    options: { lastEventId?: number; signal?: AbortSignal } = {}
  ): AsyncGenerator<DjEngineEvent> {
    const headers: Record<string, string> = {};
    if (options.lastEventId !== undefined) {
      headers["Last-Event-ID"] = options.lastEventId.toString();
    }
    const response = await this.#openEventStream(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/events`,
      options.signal,
      headers
    );
    for await (const block of this.#eventBlocks(response)) {
      const data = extractEventData(block);
      if (data !== "") yield JSON.parse(data) as DjEngineEvent;
    }
  }

  async #openEventStream(
    path: string,
    signal?: AbortSignal,
    additionalHeaders: Record<string, string> = {}
  ): Promise<Response> {
    const init: RequestInit = {
      headers: { Accept: "text/event-stream", ...additionalHeaders }
    };
    if (signal !== undefined) init.signal = signal;
    return this.#raw(path, init);
  }

  async *#eventBlocks(response: Response): AsyncGenerator<string> {
    if (response.body === null) {
      throw new Error("DJ Engine 이벤트 스트림 본문이 없습니다.");
    }
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let pendingCarriageReturn = false;
    const append = (decoded: string, flush = false): string[] => {
      let text = pendingCarriageReturn ? `\r${decoded}` : decoded;
      pendingCarriageReturn = false;
      if (!flush && text.endsWith("\r")) {
        text = text.slice(0, -1);
        pendingCarriageReturn = true;
      }
      buffer += text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
      const blocks: string[] = [];
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        if (encoder.encode(block).length > DjEngineClient.MAX_EVENT_BUFFER_BYTES) {
          throw new Error("DJ Engine 이벤트가 허용 크기를 초과했습니다.");
        }
        blocks.push(block);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
      if (
        encoder.encode(buffer).length + (pendingCarriageReturn ? 1 : 0) >
        DjEngineClient.MAX_EVENT_BUFFER_BYTES
      ) {
        throw new Error("DJ Engine 이벤트가 허용 크기를 초과했습니다.");
      }
      return blocks;
    };
    for await (const chunk of response.body) {
      for (const block of append(decoder.decode(chunk, { stream: true }))) yield block;
    }
    for (const block of append(decoder.decode(), true)) yield block;
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.#raw(path, init);
    // 테스트의 fetch stub처럼 같은 Response 인스턴스를 돌려주는 구현도 안전하게 지원합니다.
    return await response.clone().json() as T;
  }

  async #raw(path: string, init: RequestInit = {}, allowError = false): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.#apiKey}`);
    if (init.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    // API key가 리다이렉트 대상에 전달되지 않도록 엔진 응답의 redirect를 거부합니다.
    const requestInit: RequestInit = { ...init, headers, redirect: "error" };
    if (init.signal === undefined) {
      requestInit.signal = AbortSignal.timeout(this.#requestTimeoutMs);
    }
    const response = await this.#fetch(`${this.#baseUrl}${path}`, requestInit);
    if (!response.ok && !allowError) await this.#throwApiError(response);
    return response;
  }

  async #throwApiError(response: Response): Promise<never> {
    let envelope: ErrorEnvelope = {};
    try {
      envelope = await response.json() as ErrorEnvelope;
    } catch {
      // JSON이 아닌 upstream 응답도 고정된 안전한 오류로 변환합니다.
    }
    throw new DjEngineError(response.status, envelope);
  }

  #validateAudioUrl(session: DjSession): string {
    const audioUrl = new URL(session.audioUrl);
    const baseUrl = new URL(this.#baseUrl);
    const expectedPath = `/api/v1/sessions/${encodeURIComponent(session.id)}/audio.ogg`;
    const queryNames = [...audioUrl.searchParams.keys()];
    if (
      (audioUrl.protocol !== "http:" && audioUrl.protocol !== "https:") ||
      audioUrl.origin !== baseUrl.origin ||
      audioUrl.username !== "" ||
      audioUrl.password !== "" ||
      audioUrl.pathname !== expectedPath ||
      audioUrl.hash !== "" ||
      queryNames.length !== 1 ||
      queryNames[0] !== "token" ||
      (audioUrl.searchParams.get("token")?.length ?? 0) < 32
    ) {
      throw new Error("DJ Engine이 안전하지 않은 스트림 주소를 반환했습니다.");
    }
    return audioUrl.toString();
  }
}

function extractEventData(block: string): string {
  return block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
}

function safeExternalIdentifier(value: string | undefined, maximumLength: number): string | undefined {
  return value !== undefined && value.length <= maximumLength && /^[A-Za-z0-9._-]+$/u.test(value)
    ? value
    : undefined;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
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
