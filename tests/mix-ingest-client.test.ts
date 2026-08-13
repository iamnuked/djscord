import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { MixIngestClient } from "../src/infrastructure/mix-ingest-client.js";

const SECRET = "mix-secret-that-is-at-least-32-bytes";
const GUILD_ID = "123456789012345678";
const WAVEFORM_ID = "a".repeat(64);

describe("MixIngestClient", () => {
  it("snapshot JSON 원문에 timestamp와 nonce를 묶어 HMAC-SHA256 서명한다", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: {
          feedId: "feed-1",
          missingWaveformIds: ["track-1"],
          mixUrl: "https://djscord.example/mix/feed-1",
          revision: 3
        }
      })
    );
    const client = new MixIngestClient({
      baseUrl: "https://djscord.example/api/internal/v1",
      fetch: request,
      nonce: () => "nonce-1",
      now: () => new Date("2026-08-13T00:00:00Z"),
      publicUrl: "https://djscord.example/mix",
      secret: SECRET
    });
    const body = {
      bootId: "boot-1",
      capturedAt: "2026-08-13T00:00:00Z",
      monitor: { revision: 1 },
      ownerRef: `discord:guild:${GUILD_ID}`,
      playlist: { id: "playlist-1", name: "Friday" },
      publisherId: "djscord",
      schemaVersion: 1,
      sequence: 1,
      waveforms: []
    } as const;

    await expect(client.publishSnapshot(body)).resolves.toMatchObject({
      feedId: "feed-1",
      mixUrl: "https://djscord.example/mix/feed-1"
    });

    const [url, init] = request.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    const bodyText = String(init?.body);
    const canonical = `1786579200.nonce-1.${bodyText}`;
    expect(String(url)).toBe("https://djscord.example/api/internal/v1/snapshots");
    expect(headers.get("X-Djscord-Key-Id")).toBe("djscord");
    expect(headers.get("X-Djscord-Timestamp")).toBe("1786579200");
    expect(headers.get("X-Djscord-Nonce")).toBe("nonce-1");
    expect(headers.get("X-Djscord-Signature")).toBe(
      `v1=${createHmac("sha256", SECRET).update(canonical).digest("hex")}`
    );
  });

  it("waveform과 cleanup은 검증된 ID를 URL component로 인코딩하고 같은 서명 방식을 쓴다", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new MixIngestClient({
      baseUrl: "https://djscord.example/api/internal/v1",
      fetch: request,
      nonce: () => "nonce-2",
      now: () => new Date("2026-08-13T00:00:00Z"),
      publicUrl: "https://djscord.example/mix",
      secret: SECRET
    });

    await client.publishWaveform(WAVEFORM_ID, {
      schemaVersion: 1,
      trackId: "track-1",
      waveformId: WAVEFORM_ID
    });
    await client.cleanup(`discord:guild:${GUILD_ID}`, {
      bootId: "boot-1",
      capturedAt: "2026-08-13T00:01:00Z",
      sequence: 9
    });

    expect(request.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [
        `https://djscord.example/api/internal/v1/waveforms/${WAVEFORM_ID}`,
        "PUT"
      ],
      [
        `https://djscord.example/api/internal/v1/snapshots/discord%3Aguild%3A${GUILD_ID}`,
        "DELETE"
      ]
    ]);
  });

  it("waveform path/body ID 불일치와 잘못된 ownerRef를 요청 전에 거부한다", async () => {
    const request = vi.fn<typeof fetch>();
    const client = new MixIngestClient({
      baseUrl: "https://djscord.example/api/internal/v1",
      fetch: request,
      publicUrl: "https://djscord.example/mix",
      secret: SECRET
    });

    await expect(client.publishWaveform(WAVEFORM_ID, {
      schemaVersion: 1,
      trackId: "track-1",
      waveformId: "b".repeat(64)
    })).rejects.toThrow(/waveformId/u);
    await expect(client.cleanup("discord:guild:guild-1", {
      bootId: "boot-1",
      capturedAt: "2026-08-13T00:01:00Z",
      sequence: 9
    })).rejects.toThrow(/ownerRef/u);
    expect(request).not.toHaveBeenCalled();
  });

  it("설치된 Discord guild 목록을 full replacement로 동기화한다", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 204 })
    );
    const client = new MixIngestClient({
      baseUrl: "https://djscord.example/api/internal/v1",
      fetch: request,
      nonce: () => "nonce-3",
      now: () => new Date("2026-08-13T00:00:00Z"),
      publicUrl: "https://djscord.example/mix",
      secret: SECRET
    });

    await client.syncGuilds([
      { icon: null, id: "guild-1", name: "Friday Club" }
    ]);

    const [url, init] = request.mock.calls[0]!;
    expect(String(url)).toBe("https://djscord.example/api/internal/v1/guilds");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({
      capturedAt: "2026-08-13T00:00:00.000Z",
      guilds: [{ icon: null, id: "guild-1", name: "Friday Club" }],
      publisherId: "djscord",
      schemaVersion: 1
    });
  });
});
