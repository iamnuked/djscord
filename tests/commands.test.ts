import { describe, expect, it } from "vitest";

import { commandDefinitions } from "../src/discord/commands.js";

describe("commandDefinitions", () => {
  it("MVP의 한국어 명령 7개를 등록한다", () => {
    const commands = commandDefinitions.map((command) => command.toJSON());

    expect(commands.map(({ name }) => name)).toEqual([
      "재생",
      "일시정지",
      "계속",
      "스킵",
      "대기열",
      "자동재생",
      "정지"
    ]);
  });

  it("재생 명령은 필수 검색어 문자열을 받는다", () => {
    const play = commandDefinitions[0]?.toJSON();

    expect(play?.options[0]).toMatchObject({
      name: "검색어",
      required: true,
      type: 3
    });
  });

  it("자동재생 명령은 켜기와 끄기 선택지만 제공한다", () => {
    const autoplay = commandDefinitions[5]?.toJSON();

    expect(autoplay?.options[0]).toMatchObject({
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

