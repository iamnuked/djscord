import { REST, Routes } from "discord.js";

import { loadConfig } from "./config.js";
import { commandDefinitions } from "./discord/commands.js";

const config = loadConfig();
const rest = new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);

await rest.put(
  Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID),
  { body: commandDefinitions.map((command) => command.toJSON()) }
);

console.info(`테스트 서버에 슬래시 명령 ${commandDefinitions.length}개를 등록했습니다.`);

