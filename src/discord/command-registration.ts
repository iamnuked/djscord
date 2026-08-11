import { Routes } from "discord.js";

export function applicationCommandRoute(clientId: string): `/applications/${string}/commands` {
  return Routes.applicationCommands(clientId);
}
