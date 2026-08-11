import { REST } from "discord.js";

import { loadConfig } from "./config.js";
import { commandDefinitions } from "./discord/commands.js";
import { applicationCommandRoute } from "./discord/command-registration.js";

const config = loadConfig();
const rest = new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);

await rest.put(
  applicationCommandRoute(config.DISCORD_CLIENT_ID),
  { body: commandDefinitions.map((command) => command.toJSON()) }
);

console.info(`전역 슬래시 명령 ${commandDefinitions.length}개를 등록했습니다.`);
