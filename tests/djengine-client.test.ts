import { describe, expect, it, vi } from "vitest";

import { DjEngineClient } from "../src/infrastructure/djengine-client.js";

const API_KEY = "djengine-test-key-that-is-long-enough";

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
    expect(call.url).toBe("http://djengine:8000/api/v1/playlists");
    expect(call.method).toBe("GET");
    expect(call.headers.get("Authorization")).toBe(`Bearer ${API_KEY}`);
  });

  it("camelCase JSON 본문으로 세션을 만들고 data를 반환한다", async () => {
    const created = {
      ...session("preparing"),
      audioUrl: "http://djengine:8000/api/v1/sessions/session-1/audio.ogg?token=stream-token",
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
});
