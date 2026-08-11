export type PlayInput =
  | { kind: "playlist"; value: string }
  | { kind: "search"; value: string }
  | { kind: "video"; value: string };

const YOUTUBE_HOSTS = new Set([
  "m.youtube.com",
  "music.youtube.com",
  "www.youtube.com",
  "youtube.com",
  "youtu.be"
]);

export function classifyPlayInput(rawInput: string): PlayInput {
  const value = rawInput.trim();
  if (value.length === 0) {
    throw new Error("검색어를 입력해주세요.");
  }

  if (!/^https?:\/\//iu.test(value)) {
    return { kind: "search", value };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("올바른 URL을 입력해주세요.");
  }

  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("YouTube 링크만 지원합니다.");
  }

  if (url.searchParams.has("list") || url.pathname === "/playlist") {
    return { kind: "playlist", value };
  }

  return { kind: "video", value };
}

