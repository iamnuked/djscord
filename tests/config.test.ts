import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const requiredEnvironment = {
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_TOKEN: "discord-token",
  LAVALINK_PASSWORD: "a-secure-password"
};

describe("loadConfig", () => {
  it("필수 값과 Lavalink 기본 연결 정보를 읽는다", () => {
    expect(loadConfig(requiredEnvironment)).toEqual({
      ...requiredEnvironment,
      LAVALINK_HOST: "lavalink",
      LAVALINK_PORT: 2333
    });
  });

  it("Lavalink 비밀번호가 너무 짧으면 이해하기 쉬운 오류를 낸다", () => {
    expect(() =>
      loadConfig({ ...requiredEnvironment, LAVALINK_PASSWORD: "short" })
    ).toThrow("LAVALINK_PASSWORD는 12자 이상이어야 합니다.");
  });

  it("Ko-fi 후원 주소는 공식 HTTPS 페이지일 때만 허용한다", () => {
    expect(
      loadConfig({ ...requiredEnvironment, KOFI_URL: "https://ko-fi.com/test-user" }).KOFI_URL
    ).toBe("https://ko-fi.com/test-user");
    expect(() =>
      loadConfig({ ...requiredEnvironment, KOFI_URL: "https://example.com/test-user" })
    ).toThrow("KOFI_URL은 https://ko-fi.com/ 주소여야 합니다.");
  });

  it("Last.fm API 키는 선택적으로 읽되 빈 값은 거부한다", () => {
    expect(
      loadConfig({ ...requiredEnvironment, LASTFM_API_KEY: "lastfm-api-key" }).LASTFM_API_KEY
    ).toBe("lastfm-api-key");
    expect(() => loadConfig({ ...requiredEnvironment, LASTFM_API_KEY: "" })).toThrow(
      "LASTFM_API_KEY는 빈 값일 수 없습니다."
    );
  });
});
