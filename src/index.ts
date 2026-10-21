import { loadConfig } from "./config.js";
import { createMusicBot } from "./discord/music-bot.js";
import { startDesktopControlServer } from "./desktop/control-server.js";

const bot = createMusicBot(loadConfig());
const desktopServer = await startDesktopControlServer(bot);

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    desktopServer?.close();
    desktopServer?.closeAllConnections();
    await bot.stop();
    console.info(`${signal} 신호로 봇을 안전하게 종료했습니다.`);
    process.exit(0);
  } catch (error) {
    console.error(`${signal} 종료 처리에 실패했습니다.`, error);
    process.exit(1);
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

await bot.start();
