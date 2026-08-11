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
    next: track("next"),
    positionMs: 90_000,
    queueSize: 3,
    status: "playing",
    updatedAt: new Date("2026-08-11T12:00:00Z"),
    ...overrides
  };
}

describe("buildPlayerCard", () => {
  it("현재 곡, 장르 출처, 진행 바, 다음 곡과 자동재생 상태를 표시한다", () => {
    const card = buildPlayerCard(snapshot(), "session-1");
    const embed = card.embeds[0]?.toJSON();

    expect(embed?.title).toBe("track-current");
    expect(embed?.url).toContain("youtube.com");
    expect(embed?.description).toContain("▰▰▰▰▰▰▱▱▱▱▱▱");
    expect(embed?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "출처", value: expect.stringContaining("장르") }),
        expect.objectContaining({ name: "다음 곡", value: expect.stringContaining("track-next") }),
        expect.objectContaining({ name: "자동재생", value: "켜짐" })
      ])
    );
  });

  it("버튼 6개를 4개와 2개의 두 Action Row로 구성한다", () => {
    const card = buildPlayerCard(snapshot(), "session-1");
    const rows = card.components.map((row) => row.toJSON());

    expect(rows[0]?.components).toHaveLength(4);
    expect(rows[1]?.components).toHaveLength(2);
    expect(rows.flatMap(({ components }) => components)).toHaveLength(6);
  });

  it("일시정지 상태에서는 계속 버튼을 표시하고 라이브는 진행 바 대신 LIVE로 표시한다", () => {
    const paused = buildPlayerCard(
      snapshot({ current: track("live", { isStream: true }), status: "paused" }),
      "session-1"
    );
    const firstButton = paused.components[0]?.toJSON().components[0];

    expect(paused.embeds[0]?.toJSON().description).toContain("LIVE");
    expect(firstButton).toMatchObject({ label: "계속", style: ButtonStyle.Success });
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
