import { MessageFlags } from "discord.js";
import { describe, expect, it } from "vitest";

import { createHelpReply } from "../src/discord/help-view.js";

describe("createHelpReply", () => {
  it("빠른 시작과 모든 슬래시 명령을 한국어로 안내한다", () => {
    const reply = createHelpReply();
    const embed = reply.embeds?.[0];
    const json = embed !== undefined && "toJSON" in embed ? embed.toJSON() : embed;
    const text = JSON.stringify(json);

    expect(text).toContain("djscord 사용법");
    for (const command of [
      "/재생",
      "/장르",
      "/일시정지",
      "/계속",
      "/스킵",
      "/반복",
      "/셔플",
      "/삭제",
      "/이동",
      "/탐색",
      "/볼륨",
      "/정지",
      "/대기열",
      "/자동재생",
      "/사용법"
    ]) {
      expect(text).toContain(command);
    }
  });

  it("플레이어 버튼과 장르 미리보기 흐름을 설명한다", () => {
    const reply = createHelpReply();
    const embed = reply.embeds?.[0];
    const json = embed !== undefined && "toJSON" in embed ? embed.toJSON() : embed;
    const text = JSON.stringify(json);

    for (const button of ["▶️/⏸️", "⏭️", "⏹️", "🔄", "✨", "📋"] ) {
      expect(text).toContain(button);
    }
    expect(text).toContain("선택 제거");
    expect(text).toContain("확정");
  });

  it("요청자에게만 보이고 주요 제한사항을 함께 표시한다", () => {
    const reply = createHelpReply();
    const embed = reply.embeds?.[0];
    const json = embed !== undefined && "toJSON" in embed ? embed.toJSON() : embed;
    const text = JSON.stringify(json);

    expect(reply.flags).toBe(MessageFlags.Ephemeral);
    expect(text).toContain("100곡");
    expect(text).toContain("5분");
    expect(text).toContain("같은 음성 채널");
  });
});
