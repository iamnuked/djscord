import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} from "discord.js";

import type { MusicTrack, RecommendationFeedback } from "../domain/types.js";
import { formatRepeatMode, type PlaybackRepeatMode } from "../music/playback-controls.js";

const PROGRESS_SEGMENTS = 12;

export interface PlayerCardSnapshot {
  autoplayEnabled: boolean;
  current: MusicTrack | null;
  feedback: RecommendationFeedback | null;
  next: MusicTrack | null;
  positionMs: number;
  queueSize: number;
  repeatMode: PlaybackRepeatMode;
  status: "playing" | "paused" | "idle" | "ended";
  updatedAt: Date;
  volume: number;
  voiceChannelId: string | null;
}

export interface PlayerCardOptions {
  supportUrl?: string;
}

export interface PlayerCardPayload {
  components: ActionRowBuilder<ButtonBuilder>[];
  embeds: EmbedBuilder[];
}

export function buildPlayerCard(
  snapshot: PlayerCardSnapshot,
  sessionId: string,
  options: PlayerCardOptions = {}
): PlayerCardPayload {
  const ended = snapshot.status === "ended";
  const djMode = snapshot.current?.sourceName === "djengine";
  const embed = ended ? buildEndedEmbed(snapshot) : buildActiveEmbed(snapshot);
  const pauseStyle = snapshot.status === "paused" ? ButtonStyle.Success : ButtonStyle.Primary;
  const playbackDisabled = ended || snapshot.current === null || snapshot.status === "idle";

  const firstRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`music:${sessionId}:toggle`)
      .setEmoji(snapshot.status === "paused" ? "▶️" : "⏸️")
      .setStyle(pauseStyle)
      .setDisabled(playbackDisabled || djMode),
    new ButtonBuilder()
      .setCustomId(`music:${sessionId}:skip`)
      .setEmoji("⏭️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(playbackDisabled || djMode),
    new ButtonBuilder()
      .setCustomId(`music:${sessionId}:stop`)
      .setEmoji("⏹️")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(ended || djMode),
    new ButtonBuilder()
      .setCustomId(`music:${sessionId}:refresh`)
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(ended || djMode),
    new ButtonBuilder()
      .setCustomId(`music:${sessionId}:autoplay`)
      .setEmoji("✨")
      .setStyle(snapshot.autoplayEnabled ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(ended || djMode)
  );
  const secondRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`music:${sessionId}:queue`)
      .setEmoji("📋")
      .setLabel("대기열")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(ended || djMode),
    new ButtonBuilder()
      .setCustomId(`music:${sessionId}:like`)
      .setEmoji("👍")
      .setStyle(snapshot.feedback === "like" ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(playbackDisabled || djMode),
    new ButtonBuilder()
      .setCustomId(`music:${sessionId}:dislike`)
      .setEmoji("👎")
      .setStyle(snapshot.feedback === "dislike" ? ButtonStyle.Danger : ButtonStyle.Secondary)
      .setDisabled(playbackDisabled || djMode)
  );
  if (options.supportUrl !== undefined) {
    secondRow.addComponents(
      new ButtonBuilder()
        .setURL(options.supportUrl)
        .setEmoji("☕")
        .setLabel("서버비 지원")
        .setStyle(ButtonStyle.Link)
        .setDisabled(ended || djMode)
    );
  }

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
        { name: "대기열", value: `${snapshot.queueSize}곡`, inline: true },
        { name: "자동재생", value: snapshot.autoplayEnabled ? "ON" : "OFF", inline: true },
        { name: "음성채널", value: formatVoiceChannel(snapshot.voiceChannelId), inline: true }
      )
      .setFooter({ text: `마지막 갱신 · ${formatUpdatedAt(snapshot.updatedAt)}` })
      .setTimestamp(snapshot.updatedAt);
  }

  const embed = new EmbedBuilder()
    .setColor(snapshot.status === "paused" ? 0xf59e0b : 0x2f80ed)
    .setTitle(current.title)
    .setAuthor({ name: `💿 ${current.author}` })
    .setDescription(formatProgress(current, snapshot.positionMs, snapshot.status))
    .addFields(
      {
        name: "길이",
        value: current.isStream ? "LIVE" : formatDuration(current.durationMs),
        inline: true
      },
      {
        name: "요청자",
        value: formatRequester(current),
        inline: true
      },
      {
        name: "음성채널",
        value: formatVoiceChannel(snapshot.voiceChannelId),
        inline: true
      }
    )
    .setFooter({ text: formatPlayerFooter(snapshot) })
    .setTimestamp(snapshot.updatedAt);

  if (current.sourceName !== "djengine") {
    embed.setURL(current.uri);
  }

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
  return `${status === "paused" ? "⏸️" : "▶️"} \`${bar}\`  ${formatDuration(position)} / ${formatDuration(duration)}`;
}

function formatRequester(track: MusicTrack): string {
  if (track.origin === "recommended") {
    return "✨ 자동 추천";
  }
  const requester = track.requesterId === undefined ? "알 수 없음" : `<@${track.requesterId}>`;
  return track.origin === "genre" ? `${requester} · 장르` : requester;
}

function formatVoiceChannel(voiceChannelId: string | null): string {
  return voiceChannelId === null ? "연결 안 됨" : `<#${voiceChannelId}>`;
}

function formatPlayerFooter(snapshot: PlayerCardSnapshot): string {
  const next = snapshot.next === null ? "없음" : truncate(snapshot.next.title, 48);
  return `다음 · ${next}  •  대기열 ${snapshot.queueSize}곡  •  반복 ${formatRepeatMode(snapshot.repeatMode)}  •  볼륨 ${snapshot.volume}%  •  자동재생 ${snapshot.autoplayEnabled ? "ON" : "OFF"}  •  ${formatUpdatedAt(snapshot.updatedAt)}`;
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
  return date.toISOString().slice(11, 19) + " UTC";
}

function truncate(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
}
