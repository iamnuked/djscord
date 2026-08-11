import type { MusicTrack } from "../domain/types.js";

const DISPLAY_LIMIT = 10;

export function formatQueue(
  current: MusicTrack | null,
  upcoming: readonly MusicTrack[]
): string {
  if (current === null && upcoming.length === 0) {
    return "현재 재생 중인 곡이 없습니다.";
  }

  const lines: string[] = [];
  if (current !== null) {
    lines.push(`현재: ${formatTrack(current)}`);
  }

  const visible = upcoming.slice(0, DISPLAY_LIMIT);
  if (visible.length > 0) {
    lines.push("", "다음 곡:");
    visible.forEach((track, index) => {
      lines.push(`${index + 1}. ${formatTrack(track)}`);
    });
  }

  const remaining = upcoming.length - visible.length;
  if (remaining > 0) {
    lines.push(`그 외 ${remaining}곡`);
  }

  return lines.join("\n");
}

function formatTrack(track: MusicTrack): string {
  const origin = track.origin === "recommended" ? "추천" : "요청";
  return `${track.title} · ${track.author} · ${formatDuration(track)} · ${origin}`;
}

function formatDuration(track: MusicTrack): string {
  if (track.isStream) {
    return "LIVE";
  }
  const totalSeconds = Math.floor(track.durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

