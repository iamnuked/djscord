import { describe, expect, it } from "vitest";

import { commandDefinitions } from "../src/discord/commands.js";

describe("commandDefinitions", () => {
  it("플레이어와 장르 기능을 포함한 한국어 명령 8개를 등록한다", () => {
    const commands = commandDefinitions.map((command) => command.toJSON());

    expect(commands.map(({ name }) => name)).toEqual([
      "재생",
      "일시정지",
      "계속",
      "스킵",
      "대기열",
      "자동재생",
      "정지",
      "장르"
    ]);
  });

  it("장르 명령은 필수 이름과 5~30 범위의 선택 곡수를 받는다", () => {
    const genre = commandDefinitions[7]?.toJSON();

    expect(genre?.options?.[0]).toMatchObject({
      name: "이름",
      required: true,
      type: 3
    });
    expect(genre?.options?.[1]).toMatchObject({
      max_value: 30,
      min_value: 5,
      name: "곡수",
      required: false,
      type: 4
    });
  });

  it("재생 명령은 필수 검색어 문자열을 받는다", () => {
    const play = commandDefinitions[0]?.toJSON();

    expect(play?.options?.[0]).toMatchObject({
      name: "검색어",
      required: true,
      type: 3
    });
  });

  it("자동재생 명령은 켜기와 끄기 선택지만 제공한다", () => {
    const autoplay = commandDefinitions[5]?.toJSON();

    expect(autoplay?.options?.[0]).toMatchObject({
      choices: [
        { name: "켜기", value: "on" },
        { name: "끄기", value: "off" }
      ],
      name: "모드",
      required: true,
      type: 3
    });
  });
});
