import { describe, expect, it } from "vitest";

import {
  validateVoiceAccess,
  validateVoiceMembership
} from "../src/discord/voice-access.js";

describe("validateVoiceAccess", () => {
  it("음성 채널에 참여하지 않은 사용자를 거절한다", () => {
    expect(
      validateVoiceAccess({
        botCanConnect: true,
        botCanSpeak: true,
        memberChannelId: null,
        playerChannelId: null
      })
    ).toEqual({ ok: false, message: "먼저 음성 채널에 들어가주세요." });
  });

  it("기존 Player와 다른 채널의 사용자를 거절한다", () => {
    expect(
      validateVoiceAccess({
        botCanConnect: true,
        botCanSpeak: true,
        memberChannelId: "voice-2",
        playerChannelId: "voice-1"
      })
    ).toEqual({ ok: false, message: "봇과 같은 음성 채널에서만 사용할 수 있습니다." });
  });

  it("봇의 연결 및 말하기 권한 부족을 설명한다", () => {
    expect(
      validateVoiceAccess({
        botCanConnect: false,
        botCanSpeak: false,
        memberChannelId: "voice-1",
        playerChannelId: null
      })
    ).toEqual({
      ok: false,
      message: "봇에 음성 채널 연결과 말하기 권한이 필요합니다."
    });
  });

  it("조건을 만족하면 음성 채널 ID를 반환한다", () => {
    expect(
      validateVoiceAccess({
        botCanConnect: true,
        botCanSpeak: true,
        memberChannelId: "voice-1",
        playerChannelId: "voice-1"
      })
    ).toEqual({ ok: true, voiceChannelId: "voice-1" });
  });
});

describe("validateVoiceMembership", () => {
  it("봇의 말하기 권한이 사라져도 같은 채널 사용자는 종료할 수 있다", () => {
    expect(validateVoiceMembership({
      memberChannelId: "voice-1",
      playerChannelId: "voice-1"
    })).toEqual({ ok: true, voiceChannelId: "voice-1" });
  });

  it("다른 채널 사용자의 종료 요청은 거절한다", () => {
    expect(validateVoiceMembership({
      memberChannelId: "voice-2",
      playerChannelId: "voice-1"
    })).toEqual({ ok: false, message: "봇과 같은 음성 채널에서만 사용할 수 있습니다." });
  });
});
