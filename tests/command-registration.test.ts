import { describe, expect, it } from "vitest";

import { applicationCommandRoute } from "../src/discord/command-registration.js";

describe("applicationCommandRoute", () => {
  it("설치된 모든 서버에 제공되는 전역 명령 경로를 반환한다", () => {
    expect(applicationCommandRoute("client-id")).toBe("/applications/client-id/commands");
  });
});
