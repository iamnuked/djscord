import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const requiredEnvironment = {
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_TOKEN: "discord-token",
  LAVALINK_PASSWORD: "a-secure-password"
};

describe("loadConfig", () => {
  it("필수 값과 Lavalink 기본 연결 정보를 읽는다", () => {
    expect(loadConfig(requiredEnvironment)).toEqual({
      ...requiredEnvironment,
      DATABASE_PATH: "/data/djscord.sqlite",
      LAVALINK_HOST: "lavalink",
      LAVALINK_PORT: 2333
    });
  });

  it("SQLite 파일 경로를 변경할 수 있다", () => {
    expect(loadConfig({ ...requiredEnvironment, DATABASE_PATH: "/tmp/test.sqlite" }).DATABASE_PATH)
      .toBe("/tmp/test.sqlite");
  });

  it("전역 명령 등록에는 길드 ID가 필요하지 않다", () => {
    expect(() => loadConfig(requiredEnvironment)).not.toThrow();
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

  it("DJ Engine URL과 API 키는 함께 설정해야 한다", () => {
    const enabled = loadConfig({
      ...requiredEnvironment,
      DJENGINE_API_KEY: "x".repeat(32),
      DJENGINE_BASE_URL: "http://djengine:8787"
    });

    expect(enabled).toMatchObject({
      DJENGINE_API_KEY: "x".repeat(32),
      DJENGINE_BASE_URL: "http://djengine:8787"
    });
    expect(() =>
      loadConfig({ ...requiredEnvironment, DJENGINE_BASE_URL: "http://djengine:8787" })
    ).toThrow(/DJENGINE_API_KEY/);
    expect(() =>
      loadConfig({ ...requiredEnvironment, DJENGINE_API_KEY: "x".repeat(32) })
    ).toThrow(/DJENGINE_BASE_URL/);
  });

  it("DJ Engine API 키는 32바이트 이상이어야 한다", () => {
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        DJENGINE_API_KEY: "x".repeat(31),
        DJENGINE_BASE_URL: "http://djengine:8787"
      })
    ).toThrow(/DJENGINE_API_KEY.*32/u);

    const multibyteKey = "가".repeat(11);
    expect(
      loadConfig({
        ...requiredEnvironment,
        DJENGINE_API_KEY: multibyteKey,
        DJENGINE_BASE_URL: "http://djengine:8787"
      })
    ).toMatchObject({ DJENGINE_API_KEY: multibyteKey });
  });
});
