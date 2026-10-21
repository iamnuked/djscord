import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";

import { z } from "zod";

import type { MusicBot } from "../discord/music-bot.js";

const commandSchema = z.object({
  guildId: z.string().regex(/^\d{15,22}$/u),
  action: z.enum(["systemAudio", "play", "stop", "pause", "resume", "skip", "volume"]),
  voiceChannelId: z.string().regex(/^\d{15,22}$/u).optional(),
  textChannelId: z.string().regex(/^\d{15,22}$/u).optional(),
  query: z.string().trim().min(1).max(2_000).optional(),
  volume: z.number().int().min(0).max(100).optional()
}).strict();

export async function startDesktopControlServer(bot: MusicBot): Promise<Server | undefined> {
  const tokenFile = process.env.DESKTOP_CONTROL_TOKEN_FILE;
  const token = (tokenFile === undefined ? process.env.DESKTOP_CONTROL_TOKEN : readFileSync(tokenFile, "utf8"))?.trim();
  if (token === undefined) return undefined;
  if (token.length < 32) throw new Error("데스크톱 제어 인증키는 32자 이상이어야 합니다.");
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    const reply = (status: number, value: unknown) => {
      response.writeHead(status);
      response.end(JSON.stringify(value));
    };
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (request.headers.origin !== undefined || supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)) {
      reply(401, { error: "데스크톱 앱 인증이 필요합니다." });
      return;
    }
    if (request.method === "GET" && request.url === "/state") {
      reply(200, bot.desktopSnapshot());
      return;
    }
    if (request.method !== "POST" || request.url !== "/control") {
      reply(404, { error: "지원하지 않는 요청입니다." });
      return;
    }
    try {
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 8_192) {
          reply(413, { error: "요청이 너무 큽니다." });
          return;
        }
      }
      const command = commandSchema.safeParse(JSON.parse(body));
      if (!command.success) {
        reply(400, { error: "제어 요청의 값이 올바르지 않습니다." });
        return;
      }
      await bot.desktopControl(command.data);
      reply(200, bot.desktopSnapshot());
    } catch (error) {
      const message = error instanceof Error && !/https?:|token=|password/iu.test(error.message)
        ? error.message : "요청을 처리하지 못했습니다. 봇과 오디오 연결을 확인해주세요.";
      reply(400, { error: message });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(8789, "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return server;
}
