import { z } from "zod";

const environmentSchema = z.object({
  DISCORD_CLIENT_ID: z.string().min(1, "DISCORD_CLIENT_ID가 필요합니다."),
  DISCORD_GUILD_ID: z.string().min(1, "DISCORD_GUILD_ID가 필요합니다."),
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN이 필요합니다."),
  LAVALINK_HOST: z.string().min(1).default("lavalink"),
  LAVALINK_PASSWORD: z.string().min(12, "LAVALINK_PASSWORD는 12자 이상이어야 합니다."),
  LAVALINK_PORT: z.coerce.number().int().positive().max(65_535).default(2333)
});

export type AppConfig = z.infer<typeof environmentSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    const messages = result.error.issues.map((issue) => issue.message).join("\n");
    throw new Error(`환경 변수 설정을 확인해주세요:\n${messages}`);
  }
  return result.data;
}

