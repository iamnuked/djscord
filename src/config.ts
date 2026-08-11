import { z } from "zod";

const environmentSchema = z.object({
  DISCORD_CLIENT_ID: z.string().min(1, "DISCORD_CLIENT_ID가 필요합니다."),
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN이 필요합니다."),
  KOFI_URL: z
    .string()
    .refine(isKofiUrl, "KOFI_URL은 https://ko-fi.com/ 주소여야 합니다.")
    .optional(),
  LASTFM_API_KEY: z.string().min(1, "LASTFM_API_KEY는 빈 값일 수 없습니다.").optional(),
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

function isKofiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "ko-fi.com" || url.hostname === "www.ko-fi.com")
    );
  } catch {
    return false;
  }
}
