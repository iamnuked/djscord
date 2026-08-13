import { describe, expect, it } from "vitest";

import { commandDefinitions } from "../src/discord/commands.js";
import {
  isDjInteractionAllowed,
  type DjInteraction
} from "../src/discord/dj-interaction-policy.js";

describe("DJ interaction policy", () => {
  it("DJ 모드에서는 /디제이와 /볼륨 명령만 허용한다", () => {
    expect(isDjInteractionAllowed({ commandName: "디제이", kind: "command" })).toBe(true);
    expect(isDjInteractionAllowed({ commandName: "볼륨", kind: "command" })).toBe(true);

    for (const definition of commandDefinitions) {
      const commandName = definition.toJSON().name;
      const expected = commandName === "디제이" || commandName === "볼륨";
      expect(isDjInteractionAllowed({ commandName, kind: "command" })).toBe(expected);
    }
  });

  it("DJ 모드에서는 플레이어 버튼 action과 관계없이 모두 차단한다", () => {
    for (const action of [
      "toggle",
      "skip",
      "stop",
      "refresh",
      "autoplay",
      "queue",
      "like",
      "dislike",
      "genre:confirm"
    ] as const) {
      const interaction: DjInteraction = { action, kind: "component" };
      expect(isDjInteractionAllowed(interaction)).toBe(false);
    }
  });
});
