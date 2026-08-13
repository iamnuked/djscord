import { describe, expect, it, vi } from "vitest";

import { DjEngineClient } from "../src/infrastructure/djengine-client.js";

const API_KEY = "djengine-test-key-that-is-long-enough";
const STREAM_TOKEN = "stream-token-that-is-at-least-thirty-two-bytes";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status
  });
}

function session(status: "failed" | "preparing" | "ready") {
  return {
    createdAt: "2026-08-13T00:00:00.000Z",
    currentTrackId: null,
    id: "session-1",
    playlistId: "playlist-1",
    status
  };
}

function recordedRequest(request: ReturnType<typeof vi.fn<typeof fetch>>, index = 0) {
  const [input, init] = request.mock.calls[index]!;
  return {
    body:
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as unknown)
        : init?.body,
    headers: new Headers(init?.headers),
    method: init?.method ?? "GET",
    redirect: init?.redirect,
    url: String(input)
  };
}

describe("DjEngineClient", () => {
  it("인증 헤더를 넣어 플레이리스트 목록의 data를 반환한다", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: [
          { id: "playlist-1", name: "Friday Night", path: "/music/friday" }
        ],
        meta: { hasNext: false, nextCursor: null }
      })
    );
    const client = new DjEngineClient({
      apiKey: API_KEY,
      baseUrl: "http://djengine:8000/",
      fetch: request
    });

    await expect(client.listPlaylists()).resolves.toEqual([
      { id: "playlist-1", name: "Friday Night", path: "/music/friday" }
    ]);

    const call = recordedRequest(request);
    expect(call.url).toBe("http://djengine:8000/api/v1/playlists?limit=100");
    expect(call.method).toBe("GET");
    expect(call.redirect).toBe("error");
    expect(call.headers.get("Authorization")).toBe(`Bearer ${API_KEY}`);
  });

  it("camelCase JSON 본문으로 세션을 만들고 data를 반환한다", async () => {
    const created = {
      ...session("preparing"),
      audioUrl: `http://djengine:8000/api/v1/sessions/session-1/audio.ogg?token=${STREAM_TOKEN}`,
      energyProfile: "build"
    };
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ data: created }, 201)
    );
    const client = new DjEngineClient({
      apiKey: API_KEY,
      baseUrl: "http://djengine:8000",
      fetch: request
    });

    await expect(
      client.createSession({
        energyProfile: "build",
        maxDurationMinutes: 90,
        ownerRef: "discord:guild-1",
        playlistId: "playlist-1",
        seed: 7
      })
    ).resolves.toEqual(created);

    const call = recordedRequest(request);
    expect(call.url).toBe("http://djengine:8000/api/v1/sessions");
    expect(call.method).toBe("POST");
    expect(call.headers.get("Authorization")).toBe(`Bearer ${API_KEY}`);
    expect(call.headers.get("Content-Type")).toBe("application/json");
    expect(call.body).toEqual({
      energyProfile: "build",
      maxDurationMinutes: 90,
      ownerRef: "discord:guild-1",
      playlistId: "playlist-1",
      seed: 7
    });
  });

  it("인코딩한 세션 ID를 폴링하다 ready 세션을 반환한다", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: session("preparing") }))
      .mockResolvedValueOnce(
        jsonResponse({ data: { ...session("ready"), id: "session/한 글" } })
      );
    const client = new DjEngineClient({
      apiKey: API_KEY,
      baseUrl: "http://djengine:8000",
      fetch: request,
      pollIntervalMs: 10
    });

    try {
      const pending = client.waitUntilReady("session/한 글", { timeoutMs: 100 });
      await vi.runAllTimersAsync();

      await expect(pending).resolves.toMatchObject({
        id: "session/한 글",
        status: "ready"
      });
      expect(request).toHaveBeenCalledTimes(2);
      for (let index = 0; index < 2; index += 1) {
        const call = recordedRequest(request, index);
        expect(call.url).toBe(
          "http://djengine:8000/api/v1/sessions/session%2F%ED%95%9C%20%EA%B8%80"
        );
        expect(call.headers.get("Authorization")).toBe(`Bearer ${API_KEY}`);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("세션이 failed가 되면 추가 폴링 없이 실패한다", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ data: session("failed") })
    );
    const client = new DjEngineClient({
      apiKey: API_KEY,
      baseUrl: "http://djengine:8000",
      fetch: request,
      pollIntervalMs: 10
    });

    await expect(
      client.waitUntilReady("session-1", { timeoutMs: 100 })
    ).rejects.toThrow(/failed|실패/i);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("제한 시간 안에 ready가 되지 않으면 폴링을 중단한다", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ data: session("preparing") })
    );
    const client = new DjEngineClient({
      apiKey: API_KEY,
      baseUrl: "http://djengine:8000",
      fetch: request,
      pollIntervalMs: 10
    });

    try {
      const pending = client.waitUntilReady("session-1", { timeoutMs: 25 });
      const rejection = expect(pending).rejects.toThrow(/timeout|시간/i);
      await vi.runAllTimersAsync();

      await rejection;
      expect(request.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("세션 ID를 인코딩하고 기본 next_bar 단위의 명령을 전송한다", async () => {
    const scheduled = {
      commandId: "discord-command-1",
      quantize: "next_bar",
      scheduledSample: 192_000,
      type: "skip"
    };
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ data: scheduled }, 202)
    );
    const client = new DjEngineClient({
      apiKey: API_KEY,
      baseUrl: "http://djengine:8000",
      fetch: request
    });

    await expect(
      client.sendCommand("session/with space", "discord-command-1", "skip")
    ).resolves.toEqual(scheduled);

    const call = recordedRequest(request);
    expect(call.url).toBe(
      "http://djengine:8000/api/v1/sessions/session%2Fwith%20space/commands"
    );
    expect(call.method).toBe("POST");
    expect(call.headers.get("Authorization")).toBe(`Bearer ${API_KEY}`);
    expect(call.headers.get("Content-Type")).toBe("application/json");
    expect(call.body).toEqual({
      commandId: "discord-command-1",
      quantize: "next_bar",
      type: "skip"
    });
  });

  it("API 오류를 정리해 스트림 URL 토큰이 오류에 노출되지 않게 한다", async () => {
    const secretToken = "never-expose-this-stream-token";
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "stream_failed",
            details: {
              audioUrl: `http://djengine/audio.ogg?token=${secretToken}`
            },
            message: `stream failed at http://djengine/audio.ogg?token=${secretToken}`
          },
          requestId: "request-1"
        },
        502
      )
    );
    const client = new DjEngineClient({
      apiKey: API_KEY,
      baseUrl: "http://djengine:8000",
      fetch: request
    });

    const error = await client
      .createSession({ playlistId: "playlist-1" })
      .then(
        () => undefined,
        (reason: unknown) => reason
      );

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      code: "stream_failed",
      requestId: "request-1",
      status: 502
    });
    expect(String(error)).not.toContain(secretToken);
    expect((error as Error).stack).not.toContain(secretToken);
    expect(JSON.stringify((error as { details?: unknown }).details)).not.toContain(secretToken);
  });

  it("악성 error code와 requestId에 들어간 capability token도 제거한다", async () => {
    const secretToken = "never-expose-this-stream-token";
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: { code: `token=${secretToken}` },
          requestId: `https://engine/audio.ogg?token=${secretToken}`
        },
        502
      )
    );
    const client = new DjEngineClient({
      apiKey: API_KEY,
      baseUrl: "http://djengine:8000",
      fetch: request
    });

    const error = await client.createSession({ playlistId: "playlist-1" }).catch(
      (reason: unknown) => reason
    );

    expect(String(error)).not.toContain(secretToken);
    expect((error as Error).stack).not.toContain(secretToken);
    expect(JSON.stringify(error)).not.toContain(secretToken);
    expect(error).toMatchObject({ code: "unknown_error", status: 502 });
  });

  it("엔진 origin 밖이나 예상 경로가 아닌 스트림 URL을 거부한다", async () => {
    for (const audioUrl of [
      `http://169.254.169.254/latest/meta-data?token=${STREAM_TOKEN}`,
      `http://djengine:8000/admin?token=${STREAM_TOKEN}`,
      `http://djengine:8000/api/v1/sessions/session-1/audio.ogg?token=${STREAM_TOKEN}&next=http://internal`
    ]) {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse({
            data: { ...session("preparing"), audioUrl, energyProfile: "build" }
          }, 201)
        )
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      const client = new DjEngineClient({
        apiKey: API_KEY,
        baseUrl: "http://djengine:8000",
        fetch: request
      });

      await expect(client.createSession({ playlistId: "playlist-1" })).rejects.toThrow(
        /안전하지/u
      );
      expect(request).toHaveBeenCalledTimes(2);
      expect(recordedRequest(request, 1)).toMatchObject({
        method: "DELETE",
        url: "http://djengine:8000/api/v1/sessions/session-1"
      });
    }
  });

  it("안전하지 않은 스트림 URL의 세션 삭제가 실패해도 검증 오류를 보존한다", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            ...session("preparing"),
            audioUrl: `http://169.254.169.254/latest/meta-data?token=${STREAM_TOKEN}`,
            energyProfile: "build"
          }
        }, 201)
      )
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "cleanup_failed", message: "failed" } }, 503)
      );
    const client = new DjEngineClient({
      apiKey: API_KEY,
      baseUrl: "http://djengine:8000",
      fetch: request
    });

    await expect(client.createSession({ playlistId: "playlist-1" })).rejects.toThrow(
      /안전하지/u
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(recordedRequest(request, 1)).toMatchObject({
      method: "DELETE",
      url: "http://djengine:8000/api/v1/sessions/session-1"
    });
  });

  it("세션 종료 시 ID를 인코딩하고 이미 닫힌 404도 성공으로 취급한다", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: "not_found", message: "session not found" } },
          404
        )
      );
    const client = new DjEngineClient({
      apiKey: API_KEY,
      baseUrl: "http://djengine:8000",
      fetch: request
    });

    await expect(client.closeSession("session/한 글")).resolves.toBeUndefined();
    await expect(client.closeSession("session/한 글")).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledTimes(2);
    for (let index = 0; index < 2; index += 1) {
      const call = recordedRequest(request, index);
      expect(call.url).toBe(
        "http://djengine:8000/api/v1/sessions/session%2F%ED%95%9C%20%EA%B8%80"
      );
      expect(call.method).toBe("DELETE");
      expect(call.headers.get("Authorization")).toBe(`Bearer ${API_KEY}`);
    }
  });

  it("track ID를 인코딩해 2048-bin waveform을 가져온다", async () => {
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
      trackId: "track/한 글",
      waveformId: "waveform-sha256-1"
    };
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ data: waveform })
    );
    const client = new DjEngineClient({
      apiKey: API_KEY,
      baseUrl: "http://djengine:8000",
      fetch: request
    });

    await expect(client.getWaveform("track/한 글")).resolves.toEqual(waveform);

    const call = recordedRequest(request);
    expect(call.url).toBe(
      "http://djengine:8000/api/v1/tracks/track%2F%ED%95%9C%20%EA%B8%80/waveform"
    );
    expect(call.headers.get("Authorization")).toBe(`Bearer ${API_KEY}`);
  });

  it("monitor SSE의 mix.monitor.v1 snapshot만 yield한다", async () => {
    const snapshot = {
      capturedAt: "2026-08-13T00:00:01Z",
      decks: { a: null, b: null },
      master: { peakLeft: 0.2, peakRight: 0.3 },
      outputSample: 48_000,
      playing: true,
      revision: 2,
      sampleRate: 48_000,
      schemaVersion: 1,
      sessionId: "session-1",
      status: "ready",
      transition: null
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `event: mix.monitor.v1\nid: 2\ndata: ${JSON.stringify(snapshot)}\n\n`
        ));
        controller.close();
      }
    });
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(stream, { headers: { "content-type": "text/event-stream" } })
    );
    const client = new DjEngineClient({
      apiKey: API_KEY,
      baseUrl: "http://djengine:8000",
      fetch: request
    });

    const received = [];
    for await (const item of client.watchMonitor("session/1")) received.push(item);

    expect(received).toEqual([snapshot]);
    expect(recordedRequest(request).url).toBe(
      "http://djengine:8000/api/v1/sessions/session%2F1/monitor"
    );
  });

  it("monitor transition의 bassSwapAt을 engine wire 그대로 전달한다", async () => {
    const snapshot = {
      capturedAt: "2026-08-13T00:00:01Z",
      decks: { a: null, b: null },
      master: { peakLeft: 0.2, peakRight: 0.3 },
      outputSample: 48_000,
      playing: true,
      revision: 2,
      sampleRate: 48_000,
      schemaVersion: 1,
      sessionId: "session-1",
      status: "ready",
      transition: {
        bassSwapAt: 0.6,
        bassSwapProgress: 0,
        durationBars: 8,
        durationMs: 10_000,
        fromDeck: "a",
        progress: 0.25,
        style: "eq_blend",
        toDeck: "b"
      }
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `event: mix.monitor.v1\nid: 2\ndata: ${JSON.stringify(snapshot)}\n\n`
        ));
        controller.close();
      }
    });
    const client = new DjEngineClient({
      apiKey: API_KEY,
      baseUrl: "http://djengine:8000",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(stream))
    });

    const received = [];
    for await (const item of client.watchMonitor("session-1")) received.push(item);

    expect(received[0]?.transition?.bassSwapAt).toBe(0.6);
  });

  it("SSE의 CRLF가 서로 다른 청크에 나뉘어도 이벤트를 파싱한다", async () => {
    const event = {
      at: "2026-08-13T00:00:01Z",
      data: { reason: "complete" },
      event: "session.finished",
      id: 3
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of [
          `data: ${JSON.stringify(event)}\r`,
          "\n\r",
          "\n"
        ]) {
          controller.enqueue(new TextEncoder().encode(part));
        }
        controller.close();
      }
    });
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(stream, { headers: { "content-type": "text/event-stream" } })
    );
    const client = new DjEngineClient({
      apiKey: API_KEY,
      baseUrl: "http://djengine:8000",
      fetch: request
    });

    const received = [];
    for await (const item of client.watchEvents("session-1")) received.push(item);

    expect(received).toEqual([event]);
  });

  it("events 재연결 시 마지막 event ID를 헤더로 보내 replay를 이어받는다", async () => {
    const event = {
      at: "2026-08-13T00:00:02Z",
      data: {},
      event: "session.ready",
      id: 42
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `data: ${JSON.stringify(event)}\n\n`
        ));
        controller.close();
      }
    });
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(stream, { headers: { "content-type": "text/event-stream" } })
    );
    const client = new DjEngineClient({
      apiKey: API_KEY,
      baseUrl: "http://djengine:8000",
      fetch: request
    });

    const received = [];
    for await (const item of client.watchEvents("session-1", { lastEventId: 41 })) {
      received.push(item);
    }

    expect(received).toEqual([event]);
    expect(recordedRequest(request).headers.get("Last-Event-ID")).toBe("41");
  });

  it("한 청크에 작은 SSE 이벤트가 많이 묶여도 이벤트별 크기 제한을 적용한다", async () => {
    const events = Array.from({ length: 800 }, (_, id) => ({
      at: "2026-08-13T00:00:02Z",
      data: { marker: "small-event" },
      event: "track.started",
      id
    }));
    const payload = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    expect(new TextEncoder().encode(payload).length).toBeGreaterThan(
      DjEngineClient.MAX_EVENT_BUFFER_BYTES
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      }
    });
    const client = new DjEngineClient({
      apiKey: API_KEY,
      baseUrl: "http://djengine:8000",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(stream))
    });

    const received = [];
    for await (const item of client.watchEvents("session-1")) received.push(item);

    expect(received).toEqual(events);
  });
});
