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

  it("시스템 오디오 스트림 주소는 인증 정보 없는 HTTP(S) 주소만 허용한다", () => {
    expect(
      loadConfig({
        ...requiredEnvironment,
        SYSTEM_AUDIO_STREAM_URL: "http://host.docker.internal:8788/system-audio.wav"
      }).SYSTEM_AUDIO_STREAM_URL
    ).toBe("http://host.docker.internal:8788/system-audio.wav");
    for (const url of [
      "file:///tmp/system-audio.wav",
      "http://user:password@localhost:8788/system-audio.wav",
      "http://localhost:8788/system-audio.wav?token=secret"
    ]) {
      expect(() => loadConfig({ ...requiredEnvironment, SYSTEM_AUDIO_STREAM_URL: url })).toThrow(
        /SYSTEM_AUDIO_STREAM_URL/u
      );
    }
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
});
