import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");

describe("DJ Engine local Compose overlay", () => {
  it("sibling 엔진을 같은 사설 네트워크에 띄우고 bot과 Lavalink에서 접근할 URL을 사용한다", () => {
    const path = join(projectRoot, "compose.djengine.yaml");

    expect(existsSync(path)).toBe(true);
    const compose = readFileSync(path, "utf8");
    expect(compose).toContain("context: ../djengine");
    expect(compose).toContain("DJENGINE_BASE_URL: http://engine:8787");
    expect(compose).toContain("DJENGINE_PUBLIC_BASE_URL: http://engine:8787");
    expect(compose).toContain("condition: service_healthy");
    expect(compose).toContain("target: /music");
    expect(compose).toContain("target: /config/rekordbox.xml");
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("internal: true");
    expect(compose).not.toMatch(/^\s*ports:/mu);
    const baseCompose = readFileSync(join(projectRoot, "compose.yaml"), "utf8");
    const lavalink = baseCompose.split("\n  lavalink:")[1] ?? "";
    expect(lavalink).not.toContain("env_file:");
    expect(lavalink).toContain("LAVALINK_PASSWORD:");
  });
});
