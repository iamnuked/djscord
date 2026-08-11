import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} from "discord.js";

import type { MusicTrack } from "../domain/types.js";

const PROGRESS_SEGMENTS = 12;

export interface PlayerCardSnapshot {
  autoplayEnabled: boolean;
  current: MusicTrack | null;
  next: MusicTrack | null;
  positionMs: number;
  queueSize: number;
  status: "playing" | "paused" | "idle" | "ended";
  updatedAt: Date;
}

export interface PlayerCardPayload {
  components: ActionRowBuilder<ButtonBuilder>[];
  embeds: EmbedBuilder[];
}

export function buildPlayerCard(
  snapshot: PlayerCardSnapshot,
  sessionId: string
): PlayerCardPayload {
  const ended = snapshot.status === "ended";
  const embed = ended ? buildEndedEmbed(snapshot) : buildActiveEmbed(snapshot);
  const pauseLabel = snapshot.status === "paused" ? "계속" : "일시정지";
  const pauseStyle = snapshot.status === "paused" ? ButtonStyle.Success : ButtonStyle.Primary;
  const playbackDisabled = ended || snapshot.current === null || snapshot.status === "idle";

  const firstRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`music:${sessionId}:toggle`)
      .setLabel(pauseLabel)
      .setStyle(pauseStyle)
      .setDisabled(playbackDisabled),
    new ButtonBuilder()
      .setCustomId(`music:${sessionId}:skip`)
      .setLabel("스킵")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(playbackDisabled),
    new ButtonBuilder()
      .setCustomId(`music:${sessionId}:stop`)
      .setLabel("정지")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(ended),
    new ButtonBuilder()
      .setCustomId(`music:${sessionId}:refresh`)
      .setLabel("새로고침")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(ended)
  );
  const secondRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`music:${sessionId}:queue`)
      .setLabel("대기열")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(ended),
    new ButtonBuilder()
      .setCustomId(`music:${sessionId}:autoplay`)
      .setLabel("자동재생")
      .setStyle(snapshot.autoplayEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(ended)
  );

  return { components: [firstRow, secondRow], embeds: [embed] };
}

function buildEndedEmbed(snapshot: PlayerCardSnapshot): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x6b7280)
    .setTitle("재생 종료")
    .setDescription("음성 채널 연결과 재생 세션이 종료되었습니다.")
    .setFooter({ text: `마지막 갱신 · ${formatUpdatedAt(snapshot.updatedAt)}` })
    .setTimestamp(snapshot.updatedAt);
}

function buildActiveEmbed(snapshot: PlayerCardSnapshot): EmbedBuilder {
  const current = snapshot.current;
  if (current === null) {
    return new EmbedBuilder()
      .setColor(0xf59e0b)
      .setTitle("대기열 종료")
      .setDescription("재생할 다음 곡을 기다리고 있습니다.")
      .addFields(
        { name: "남은 대기열", value: `${snapshot.queueSize}곡`, inline: true },
        { name: "자동재생", value: snapshot.autoplayEnabled ? "켜짐" : "꺼짐", inline: true }
      )
      .setFooter({ text: `마지막 갱신 · ${formatUpdatedAt(snapshot.updatedAt)}` })
      .setTimestamp(snapshot.updatedAt);
  }

  const embed = new EmbedBuilder()
    .setColor(snapshot.status === "paused" ? 0xf59e0b : 0x5865f2)
    .setTitle(current.title)
    .setURL(current.uri)
    .setAuthor({ name: current.author })
    .setDescription(formatProgress(current, snapshot.positionMs, snapshot.status))
    .addFields(
      {
        name: "출처",
        value: `${formatOrigin(current)}${formatRequester(current)}`,
        inline: true
      },
      {
        name: "다음 곡",
        value: snapshot.next === null ? "없음" : snapshot.next.title,
        inline: true
      },
      { name: "남은 대기열", value: `${snapshot.queueSize}곡`, inline: true },
      { name: "자동재생", value: snapshot.autoplayEnabled ? "켜짐" : "꺼짐", inline: true }
    )
    .setFooter({ text: `마지막 갱신 · ${formatUpdatedAt(snapshot.updatedAt)}` })
    .setTimestamp(snapshot.updatedAt);

  if (current.artworkUrl !== undefined && current.artworkUrl !== null) {
    embed.setThumbnail(current.artworkUrl);
  }
  return embed;
}

function formatProgress(
  track: MusicTrack,
  positionMs: number,
  status: PlayerCardSnapshot["status"]
): string {
  if (track.isStream) {
    return `${status === "paused" ? "⏸️" : "🔴"} LIVE`;
  }
  const duration = Math.max(0, track.durationMs);
  const position = Math.min(Math.max(0, positionMs), duration);
  const ratio = duration === 0 ? 0 : position / duration;
  const filled = Math.min(PROGRESS_SEGMENTS, Math.floor(ratio * PROGRESS_SEGMENTS));
  const bar = "▰".repeat(filled) + "▱".repeat(PROGRESS_SEGMENTS - filled);
  return `${status === "paused" ? "⏸️" : "▶️"} ${bar}\n${formatDuration(position)} / ${formatDuration(duration)}`;
}

function formatOrigin(track: MusicTrack): string {
  return track.origin === "recommended" ? "자동 추천" : track.origin === "genre" ? "장르" : "요청";
}

function formatRequester(track: MusicTrack): string {
  return track.requesterId === undefined ? "" : ` · <@${track.requesterId}>`;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

function formatUpdatedAt(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}
