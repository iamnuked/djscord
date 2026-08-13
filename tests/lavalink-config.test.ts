import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("Lavalink audio sources", () => {
  it("DJ Engine의 Ogg Opus 스트림을 불러올 수 있도록 HTTP 소스를 활성화한다", () => {
    const configuration = readFileSync(
      new URL("../lavalink/application.yml", import.meta.url),
      "utf8"
    );
    const httpSource = configuration
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith("http:"));

    expect(httpSource).toBe("http: true");
  });
});
