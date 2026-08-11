import { describe, expect, it } from "vitest";

import { classifyPlayInput } from "../src/domain/input.js";

describe("classifyPlayInput", () => {
  it("YouTube 영상 URL을 단일 트랙으로 분류한다", () => {
    expect(classifyPlayInput("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({
      kind: "video",
      value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    });
  });

  it("youtu.be 단축 URL을 단일 트랙으로 분류한다", () => {
    expect(classifyPlayInput("https://youtu.be/dQw4w9WgXcQ")).toEqual({
      kind: "video",
      value: "https://youtu.be/dQw4w9WgXcQ"
    });
  });

  it("list 파라미터가 있는 URL을 재생목록으로 우선 분류한다", () => {
    expect(
      classifyPlayInput(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1234567890"
      )
    ).toEqual({
      kind: "playlist",
      value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1234567890"
    });
  });

  it("일반 문자열을 검색어로 분류하고 공백을 제거한다", () => {
    expect(classifyPlayInput("  아이유 좋은 날  ")).toEqual({
      kind: "search",
      value: "아이유 좋은 날"
    });
  });

  it("빈 검색어를 거절한다", () => {
    expect(() => classifyPlayInput("   ")).toThrow("검색어를 입력해주세요.");
  });

  it("지원하지 않는 URL을 거절한다", () => {
    expect(() => classifyPlayInput("https://example.com/song.mp3")).toThrow(
      "YouTube 링크만 지원합니다."
    );
  });
});

