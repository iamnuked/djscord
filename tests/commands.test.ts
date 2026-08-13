import { describe, expect, it } from "vitest";

import { commandDefinitions } from "../src/discord/commands.js";

function command(name: string) {
  return commandDefinitions
    .map((definition) => definition.toJSON())
    .find((item) => item.name === name);
}

describe("commandDefinitions", () => {
  it("재생 제어, 장르, DJ Engine, 저장 음악, 서버 설정과 사용법 명령을 등록한다", () => {
    const commands = commandDefinitions.map((command) => command.toJSON());

    expect(commands.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "재생",
        "일시정지",
        "계속",
        "스킵",
        "반복",
        "셔플",
        "삭제",
        "이동",
        "탐색",
        "볼륨",
        "대기열",
        "자동재생",
        "정지",
        "장르",
        "디제이",
        "설정",
        "좋아요",
        "내음악",
        "플레이리스트",
        "사용법"
      ])
    );
  });

  it("장르 명령은 필수 이름과 5~30 범위의 선택 곡수를 받는다", () => {
    const genre = command("장르");

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
    const play = command("재생");

    expect(play?.options?.[0]).toMatchObject({
      name: "검색어",
      required: true,
      type: 3
    });
  });

  it("자동재생 명령은 켜기와 끄기 선택지만 제공한다", () => {
    const autoplay = command("자동재생");

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

  it("사용법 명령은 별도 입력값 없이 실행한다", () => {
    expect(command("사용법")).toMatchObject({
      description: "음악 봇의 명령과 플레이어 사용법을 확인합니다.",
      name: "사용법",
      options: []
    });
  });

  it("플레이리스트는 저장·목록·재생·삭제 하위 명령을 제공한다", () => {
    const playlist = command("플레이리스트");

    expect(playlist?.name).toBe("플레이리스트");
    expect(playlist?.options?.map(({ name }) => name)).toEqual(["저장", "목록", "재생", "삭제"]);
    for (const option of playlist?.options ?? []) {
      if (option.name === "목록") continue;
      expect("options" in option ? option.options?.[0] : undefined).toMatchObject({
        max_length: 40,
        min_length: 1,
        name: "이름",
        required: true,
        type: 3
      });
    }
  });

  it("설정 명령은 서버 관리자가 기본 볼륨과 자동재생 기본값을 선택적으로 바꾼다", () => {
    const settings = command("설정");

    expect(settings).toMatchObject({
      default_member_permissions: "32",
      name: "설정"
    });
    expect(settings?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          max_value: 100,
          min_value: 0,
          name: "기본볼륨",
          required: false,
          type: 4
        }),
        expect.objectContaining({
          choices: [
            { name: "켜기", value: "on" },
            { name: "끄기", value: "off" }
          ],
          name: "자동재생",
          required: false,
          type: 3
        })
      ])
    );
  });

  it("디제이는 목록 조회와 플레이리스트 기반 세션 시작을 제공한다", () => {
    const dj = command("디제이");
    const subcommands = dj?.options ?? [];
    const start = subcommands.find(({ name }) => name === "시작");
    const startOptions = start !== undefined && "options" in start ? (start.options ?? []) : [];
    const playlist = startOptions.find(({ name }) => name === "플레이리스트");
    const energy = startOptions.find(({ name }) => name === "에너지");
    const duration = startOptions.find(({ type }) => type === 4);
    const energyChoices =
      energy !== undefined && "choices" in energy
        ? (energy.choices ?? []).map(({ value }) => value)
        : [];

    expect(subcommands.map(({ name }) => name)).toEqual(expect.arrayContaining(["목록", "시작"]));
    expect(playlist).toMatchObject({ name: "플레이리스트", required: true, type: 3 });
    expect(new Set(energyChoices)).toEqual(
      new Set(["flat", "warmup", "build", "peak", "cooldown"])
    );
    expect(duration).toMatchObject({ max_value: 120, min_value: 5, type: 4 });
  });

  it("반복·삭제·이동·탐색·볼륨 입력 범위를 정의한다", () => {
    const commands = new Map(
      commandDefinitions.map((command) => {
        const json = command.toJSON();
        return [json.name, json] as const;
      })
    );

    expect(commands.get("반복")?.options?.[0]).toMatchObject({
      choices: [
        { name: "끄기", value: "off" },
        { name: "한 곡", value: "track" },
        { name: "대기열 전체", value: "queue" }
      ],
      name: "모드",
      required: true,
      type: 3
    });
    expect(commands.get("삭제")?.options?.[0]).toMatchObject({ min_value: 1, name: "번호" });
    expect(commands.get("이동")?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ min_value: 1, name: "곡" }),
        expect.objectContaining({ min_value: 1, name: "위치" })
      ])
    );
    expect(commands.get("탐색")?.options?.[0]).toMatchObject({ name: "시간", required: true });
    expect(commands.get("볼륨")?.options?.[0]).toMatchObject({
      max_value: 100,
      min_value: 0,
      name: "값"
    });
  });
});
