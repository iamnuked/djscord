import { ButtonStyle } from "discord.js";
import { describe, expect, it } from "vitest";

import type { MusicTrack } from "../src/domain/types.js";
import { buildPlayerCard, type PlayerCardSnapshot } from "../src/discord/player-view.js";

function track(
  identifier: string,
  options: Partial<Pick<MusicTrack, "isStream" | "origin">> = {}
): MusicTrack {
  return {
    artworkUrl: "https://example.com/art.jpg",
    author: "artist",
    durationMs: 180_000,
    encoded: `encoded-${identifier}`,
    identifier,
    isSeekable: true,
    isStream: options.isStream ?? false,
    origin: options.origin ?? "requested",
    requesterId: "user-1",
    sourceName: "youtube",
    title: `track-${identifier}`,
    uri: `https://youtube.com/watch?v=${identifier}`
  };
}

function snapshot(overrides: Partial<PlayerCardSnapshot> = {}): PlayerCardSnapshot {
  return {
    autoplayEnabled: true,
    current: track("current", { origin: "genre" }),
    feedback: null,
    next: track("next"),
    positionMs: 90_000,
    queueSize: 3,
    repeatMode: "queue",
    status: "playing",
    updatedAt: new Date("2026-08-11T12:00:00Z"),
    volume: 75,
    voiceChannelId: "voice-1",
    ...overrides
  };
}

describe("buildPlayerCard", () => {
  it("앨범형 헤더와 길이·요청자·음성채널 중심의 컴팩트한 정보를 표시한다", () => {
    const card = buildPlayerCard(snapshot(), "session-1");
    const embed = card.embeds[0]?.toJSON();

    expect(embed?.title).toBe("track-current");
    expect(embed?.url).toContain("youtube.com");
    expect(embed?.author?.name).toBe("💿 artist");
    expect(embed?.description).toContain("▰▰▰▰▰▰▱▱▱▱▱▱");
    expect(embed?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "길이", value: "3:00" }),
        expect.objectContaining({ name: "요청자", value: expect.stringContaining("<@user-1>") }),
        expect.objectContaining({ name: "음성채널", value: "<#voice-1>" })
      ])
    );
    expect(embed?.footer?.text).toContain("다음 · track-next");
    expect(embed?.footer?.text).toContain("자동재생 ON");
    expect(embed?.footer?.text).toContain("반복 전체");
    expect(embed?.footer?.text).toContain("볼륨 75%");
  });

  it("핵심 제어 5개를 아이콘 한 줄로 표시하고 대기열·추천 피드백·후원을 보조 줄에 둔다", () => {
    const card = buildPlayerCard(snapshot(), "session-1", {
      supportUrl: "https://ko-fi.com/test-user"
    });
    const rows = card.components.map((row) => row.toJSON());
    const firstRow = rows[0]?.components ?? [];
    const secondRow = rows[1]?.components ?? [];

    expect(firstRow).toHaveLength(5);
    expect(
      firstRow.map((component) => ("emoji" in component ? component.emoji?.name : undefined))
    ).toEqual(["⏸️", "⏭️", "⏹️", "🔄", "✨"]);
    expect(secondRow).toHaveLength(4);
    expect(secondRow[0]).toMatchObject({ label: "대기열" });
    expect(secondRow[1]).toMatchObject({ emoji: { name: "👍" } });
    expect(secondRow[2]).toMatchObject({ emoji: { name: "👎" } });
    expect(secondRow[3]).toMatchObject({
      label: "서버비 지원",
      style: ButtonStyle.Link,
      url: "https://ko-fi.com/test-user"
    });
  });

  it("일시정지 상태에서는 계속 버튼을 표시하고 라이브는 진행 바 대신 LIVE로 표시한다", () => {
    const paused = buildPlayerCard(
      snapshot({ current: track("live", { isStream: true }), status: "paused" }),
      "session-1"
    );
    const firstButton = paused.components[0]?.toJSON().components[0];

    expect(paused.embeds[0]?.toJSON().description).toContain("LIVE");
    expect(firstButton).toMatchObject({ emoji: { name: "▶️" }, style: ButtonStyle.Success });
  });

  it("Ko-fi URL이 없으면 후원 버튼만 숨기고 음악 제어는 유지한다", () => {
    const card = buildPlayerCard(snapshot(), "session-1");
    const components = card.components.flatMap((row) => row.toJSON().components);

    expect(components).toHaveLength(8);
    expect(components.some(({ style }) => style === ButtonStyle.Link)).toBe(false);
  });

  it("현재 곡의 추천 피드백 버튼을 활성 스타일로 표시한다", () => {
    const liked = buildPlayerCard(snapshot({ feedback: "like" }), "session-1");
    const disliked = buildPlayerCard(snapshot({ feedback: "dislike" }), "session-1");

    expect(liked.components[1]?.toJSON().components[1]).toMatchObject({
      style: ButtonStyle.Success
    });
    expect(disliked.components[1]?.toJSON().components[2]).toMatchObject({
      style: ButtonStyle.Danger
    });
  });

  it("종료 상태에서는 모든 버튼을 비활성화한다", () => {
    const card = buildPlayerCard(
      snapshot({ current: null, next: null, positionMs: 0, queueSize: 0, status: "ended" }),
      "session-1"
    );

    expect(
      card.components.flatMap((row) => row.toJSON().components).every(({ disabled }) => disabled)
    ).toBe(true);
    expect(card.embeds[0]?.toJSON().title).toBe("재생 종료");
  });
});
