import { loadConfig } from "./config.js";
import { createMusicBot } from "./discord/music-bot.js";

const bot = createMusicBot(loadConfig());

process.once("SIGINT", () => bot.client.destroy());
process.once("SIGTERM", () => bot.client.destroy());

await bot.start();
