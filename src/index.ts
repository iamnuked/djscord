import { loadConfig } from "./config.js";
import { createMusicBot } from "./discord/music-bot.js";

const bot = createMusicBot(loadConfig());

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());

await bot.start();
