import { describe, expect, it, vi } from "vitest";

import { LastFmGenreArtistProvider } from "../src/infrastructure/lastfm-genre-artist-provider.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status
  });
}

describe("LastFmGenreArtistProvider", () => {
  it("장르 태그의 상위 아티스트를 요청하고 중복·빈 이름을 제거한다", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        topartists: {
          artist: [
            { name: "Radiohead" },
            { name: "radiohead" },
            { name: "" },
            { name: "The Beatles" }
          ]
        }
      })
    );
    const provider = new LastFmGenreArtistProvider({
      apiKey: "lastfm-test-key",
      fetch: request,
      userAgent: "djscord-test/1.0"
    });

    const artists = await provider.getTopArtists(" Rock ", 6);

    expect(artists).toEqual(["Radiohead", "The Beatles"]);
    const [input, init] = request.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe("https://ws.audioscrobbler.com/2.0/");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      api_key: "lastfm-test-key",
      format: "json",
      limit: "6",
      method: "tag.gettopartists",
      page: "1",
      tag: "rock"
    });
    expect(init?.headers).toMatchObject({ "User-Agent": "djscord-test/1.0" });
  });

  it("같은 장르 결과를 TTL 동안 캐시하고 만료 뒤 다시 요청한다", async () => {
    let now = 1_000;
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ topartists: { artist: [{ name: "First Artist" }] } })
      )
      .mockResolvedValueOnce(
        jsonResponse({ topartists: { artist: [{ name: "Updated Artist" }] } })
      );
    const provider = new LastFmGenreArtistProvider({
      apiKey: "lastfm-test-key",
      cacheTtlMs: 60_000,
      fetch: request,
      now: () => now
    });

    expect(await provider.getTopArtists("jazz", 6)).toEqual(["First Artist"]);
    now += 59_999;
    expect(await provider.getTopArtists("JAZZ", 6)).toEqual(["First Artist"]);
    expect(request).toHaveBeenCalledTimes(1);

    now += 1;
    expect(await provider.getTopArtists("jazz", 6)).toEqual(["Updated Artist"]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("HTTP 오류, Last.fm 오류 응답, 잘못된 응답을 구분해 안내한다", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ message: "unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ error: 29, message: "Rate limit exceeded" }))
      .mockResolvedValueOnce(jsonResponse({ topartists: { artist: "invalid" } }));
    const provider = new LastFmGenreArtistProvider({
      apiKey: "lastfm-test-key",
      fetch: request
    });

    await expect(provider.getTopArtists("rock", 6)).rejects.toThrow(
      "Last.fm 요청에 실패했습니다 (503)"
    );
    await expect(provider.getTopArtists("rock", 6)).rejects.toThrow(
      "Last.fm API 오류 (29): Rate limit exceeded"
    );
    await expect(provider.getTopArtists("rock", 6)).rejects.toThrow(
      "Last.fm 응답 형식을 이해할 수 없습니다"
    );
  });

  it("빈 장르와 1~50 밖의 요청 개수를 거부한다", async () => {
    const provider = new LastFmGenreArtistProvider({
      apiKey: "lastfm-test-key",
      fetch: vi.fn<typeof fetch>()
    });

    await expect(provider.getTopArtists(" ", 6)).rejects.toThrow("장르 태그");
    await expect(provider.getTopArtists("rock", 0)).rejects.toThrow("1명에서 50명");
    await expect(provider.getTopArtists("rock", 51)).rejects.toThrow("1명에서 50명");
  });
});
