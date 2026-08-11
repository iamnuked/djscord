import {
  ActionRowBuilder,
  type ChatInputCommandInteraction,
  Client,
  ComponentType,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  type SendableChannels,
  StringSelectMenuBuilder,
  type VoiceBasedChannel,
  type VoiceState
} from "discord.js";
import { LavalinkManager, type Player, type Track } from "lavalink-client";

import type { AppConfig } from "../config.js";
import { GuildStateStore } from "../domain/guild-state.js";
import type { MusicTrack } from "../domain/types.js";
import {
  fromLavalinkTrack,
  LavalinkTrackLoader
} from "../infrastructure/lavalink-track-loader.js";
import { AutoplayService } from "../music/autoplay-service.js";
import { IdleTimerManager } from "../music/idle-timer.js";
import { TrackResolverService } from "../music/track-resolver.js";
import { formatQueue } from "./queue-view.js";
import { validateVoiceAccess } from "./voice-access.js";

const IDLE_TIMEOUT_MS = 300_000;
const MANUAL_QUEUE_LIMIT = 100;
const SEARCH_SELECTION_TIMEOUT_MS = 30_000;

export interface MusicBot {
  client: Client;
  lavalink: LavalinkManager;
  start(): Promise<void>;
}

export function createMusicBot(config: AppConfig): MusicBot {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
  });
  const states = new GuildStateStore();
  const idleTimers = new IdleTimerManager(IDLE_TIMEOUT_MS);
  const pausedForEmptyChannel = new Set<string>();
  const autoplayFailures = new Set<string>();

  const lavalink = new LavalinkManager({
    autoMove: true,
    autoSkip: true,
    autoSkipOnResolveError: true,
    client: { id: config.DISCORD_CLIENT_ID },
    nodes: [
      {
        authorization: config.LAVALINK_PASSWORD,
        host: config.LAVALINK_HOST,
        id: "local-lavalink",
        port: config.LAVALINK_PORT,
        retryAmount: 5,
        retryDelay: 5_000,
        secure: false
      }
    ],
    playerOptions: {
      defaultSearchPlatform: "ytmsearch",
      minAutoPlayMs: 10_000,
      onDisconnect: {
        autoReconnect: true,
        autoReconnectOnlyWithTracks: true,
        destroyPlayer: false
      },
      onEmptyQueue: {
        autoPlayFunction: async (player, lastPlayedTrack) => {
          await enqueueRecommendation(player, lastPlayedTrack);
        }
      },
      useUnresolvedData: false
    },
    queueOptions: { maxPreviousTracks: 20 },
    sendToShard: (guildId, payload) => {
      client.guilds.cache.get(guildId)?.shard.send(payload);
    }
  });

  async function enqueueRecommendation(player: Player, lastPlayedTrack: Track): Promise<void> {
    const state = states.getOrCreate(player.guildId);
    if (!state.autoplayEnabled) {
      return;
    }

    try {
      const loader = new LavalinkTrackLoader(player);
      const service = new AutoplayService(loader);
      const recommended = await service.recommend({
        enabled: state.autoplayEnabled,
        lastTrack: fromLavalinkTrack(lastPlayedTrack),
        queuedTrackIds: new Set(
          player.queue.tracks.flatMap((track) =>
            "resolve" in track ? [] : [track.info.identifier]
          )
        ),
        recentTrackIds: new Set(state.recentTrackIds)
      });

      if (recommended === undefined) {
        await notifyAutoplayFailure(player);
        return;
      }

      autoplayFailures.delete(player.guildId);
      await player.queue.add(loader.toLavalinkTrack(recommended));
    } catch (error) {
      console.error("추천곡 조회에 실패했습니다.", error);
      await notifyAutoplayFailure(player);
    }
  }

  async function notifyAutoplayFailure(player: Player): Promise<void> {
    if (autoplayFailures.has(player.guildId)) {
      return;
    }
    autoplayFailures.add(player.guildId);
    await sendToPlayerChannel(
      player,
      "추천곡을 찾지 못했습니다. 5분 동안 새 요청이 없으면 음성 채널에서 나갑니다."
    );
  }

  function schedulePlayerDestroy(player: Player): void {
    idleTimers.schedule(player.guildId, async () => {
      const current = lavalink.getPlayer(player.guildId);
      if (current !== player) {
        return;
      }
      await current.stopPlaying(true, false);
      await current.destroy("5분 동안 재생 요청 또는 청취자가 없어 자동 종료");
    });
  }

  lavalink.on("trackStart", (player, track) => {
    if (track === null) {
      return;
    }
    idleTimers.cancel(player.guildId);
    autoplayFailures.delete(player.guildId);
    states.rememberTrack(player.guildId, track.info.identifier);
    const musicTrack = fromLavalinkTrack(track);
    void sendToPlayerChannel(
      player,
      `▶️ **${musicTrack.title}** · ${musicTrack.author} (${musicTrack.origin === "recommended" ? "추천" : "요청"})`
    );
  });

  lavalink.on("trackError", (player, track, payload) => {
    console.error(`트랙 재생 오류: ${track?.info.title ?? "알 수 없는 곡"}`, payload);
    void sendToPlayerChannel(player, "현재 곡을 재생하지 못해 다음 곡으로 넘어갑니다.");
  });

  lavalink.on("trackStuck", (player, track) => {
    console.error(`트랙 멈춤: ${track?.info.title ?? "알 수 없는 곡"}`);
    void sendToPlayerChannel(player, "현재 곡의 재생이 멈춰 다음 곡으로 넘어갑니다.");
  });

  lavalink.on("queueEnd", (player) => {
    schedulePlayerDestroy(player);
  });

  lavalink.on("playerDestroy", (player) => {
    idleTimers.cancel(player.guildId);
    pausedForEmptyChannel.delete(player.guildId);
    autoplayFailures.delete(player.guildId);
    states.delete(player.guildId);
  });

  client.on("raw", (payload) => {
    lavalink.sendRawData(payload);
  });

  client.on("voiceStateUpdate", (oldState, newState) => {
    void handleVoiceStateUpdate(oldState, newState);
  });

  client.on("interactionCreate", (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }
    void handleCommand(interaction).catch(async (error: unknown) => {
      console.error("명령 처리 중 오류가 발생했습니다.", error);
      await respondWithError(interaction, error);
    });
  });

  client.once("ready", async (readyClient) => {
    await lavalink.init({ id: readyClient.user.id, username: readyClient.user.username });
    console.info(`${readyClient.user.tag} 계정으로 로그인했습니다.`);
  });

  async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.guild === null || interaction.guildId === null) {
      await interaction.reply({
        content: "Discord 서버 안에서만 사용할 수 있습니다.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    switch (interaction.commandName) {
      case "재생":
        await handlePlay(interaction);
        break;
      case "일시정지":
        await handlePause(interaction);
        break;
      case "계속":
        await handleResume(interaction);
        break;
      case "스킵":
        await handleSkip(interaction);
        break;
      case "대기열":
        await handleQueue(interaction);
        break;
      case "자동재생":
        await handleAutoplay(interaction);
        break;
      case "정지":
        await handleStop(interaction);
        break;
      default:
        await interaction.reply({
          content: "지원하지 않는 명령입니다.",
          flags: MessageFlags.Ephemeral
        });
    }
  }

  async function handlePlay(interaction: ChatInputCommandInteraction): Promise<void> {
    const voice = await getVoiceContext(interaction);
    if (!voice.ok) {
      await interaction.reply({ content: voice.message, flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply();
    const existing = lavalink.getPlayer(interaction.guildId!);
    const player =
      existing ??
      lavalink.createPlayer({
        guildId: interaction.guildId!,
        selfDeaf: true,
        selfMute: false,
        textChannelId: interaction.channelId,
        voiceChannelId: voice.voiceChannelId,
        volume: 100
      });
    const loader = new LavalinkTrackLoader(player);
    const resolver = new TrackResolverService(loader);
    const query = interaction.options.getString("검색어", true);

    try {
      const resolved = await resolver.resolve(query, interaction.user.id);
      let selectedTracks = resolved.tracks;

      if (resolved.kind === "selection") {
        const selected = await selectSearchResult(interaction, resolved.tracks);
        if (selected === undefined) {
          if (existing === undefined) {
            await player.destroy("검색 결과 선택 시간 초과");
          }
          return;
        }
        selectedTracks = [selected];
      }

      const availableSlots = Math.max(0, MANUAL_QUEUE_LIMIT - player.queue.tracks.length);
      const accepted = selectedTracks.slice(0, availableSlots);
      const skipped = resolved.skipped + selectedTracks.length - accepted.length;
      if (accepted.length === 0) {
        await interaction.editReply("대기열이 100곡으로 가득 찼습니다.");
        return;
      }

      idleTimers.cancel(player.guildId);
      if (!player.connected) {
        await player.connect();
      }
      await player.queue.add(accepted.map((track) => loader.toLavalinkTrack(track)));
      if (!player.playing && !player.paused && player.queue.current === null) {
        await player.play();
      }

      const skipText = skipped > 0 ? ` 제한으로 ${skipped}곡은 제외했습니다.` : "";
      const unavailableText =
        resolved.unavailable > 0
          ? ` 삭제·비공개 등 재생할 수 없는 ${resolved.unavailable}곡은 제외했습니다.`
          : "";
      await interaction.editReply(
        `대기열에 ${accepted.length}곡을 추가했습니다.${skipText}${unavailableText}`
      );
    } catch (error) {
      if (existing === undefined && player.queue.current === null && player.queue.tracks.length === 0) {
        await player.destroy("재생 요청 실패");
      }
      throw error;
    }
  }

  async function selectSearchResult(
    interaction: ChatInputCommandInteraction,
    tracks: readonly MusicTrack[]
  ): Promise<MusicTrack | undefined> {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`music-search:${interaction.id}`)
      .setPlaceholder("재생할 곡을 선택해주세요.")
      .addOptions(
        tracks.map((track, index) => ({
          description: truncate(`${track.author} · ${formatMilliseconds(track.durationMs)}`, 100),
          label: truncate(track.title, 100),
          value: String(index)
        }))
      );
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
    const message = await interaction.editReply({
      components: [row],
      content: "검색 결과에서 재생할 곡을 선택해주세요."
    });

    try {
      const selection = await message.awaitMessageComponent({
        componentType: ComponentType.StringSelect,
        filter: async (candidate) => {
          if (candidate.user.id === interaction.user.id) {
            return true;
          }
          await candidate.reply({
            content: "검색을 요청한 사용자만 곡을 선택할 수 있습니다.",
            flags: MessageFlags.Ephemeral
          });
          return false;
        },
        time: SEARCH_SELECTION_TIMEOUT_MS
      });
      const selected = tracks[Number(selection.values[0])];
      await selection.update({ components: [], content: `선택: **${selected?.title ?? "알 수 없는 곡"}**` });
      return selected;
    } catch {
      await interaction.editReply({
        components: [],
        content: "30초 안에 곡을 선택하지 않아 요청을 취소했습니다."
      });
      return undefined;
    }
  }

  async function handlePause(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = await requireControllablePlayer(interaction);
    if (player === undefined) return;
    if (player.paused) {
      await interaction.reply({ content: "이미 일시정지 상태입니다.", flags: MessageFlags.Ephemeral });
      return;
    }
    await player.pause();
    await interaction.reply("재생을 일시정지했습니다.");
  }

  async function handleResume(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = await requireControllablePlayer(interaction);
    if (player === undefined) return;
    if (!player.paused) {
      await interaction.reply({ content: "일시정지된 곡이 없습니다.", flags: MessageFlags.Ephemeral });
      return;
    }
    pausedForEmptyChannel.delete(player.guildId);
    idleTimers.cancel(player.guildId);
    await player.resume();
    await interaction.reply("재생을 계속합니다.");
  }

  async function handleSkip(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = await requireControllablePlayer(interaction);
    if (player === undefined) return;
    await player.skip(0, false);
    await interaction.reply("현재 곡을 건너뛰었습니다.");
  }

  async function handleQueue(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = lavalink.getPlayer(interaction.guildId!);
    if (player === undefined) {
      await interaction.reply("현재 재생 중인 곡이 없습니다.");
      return;
    }
    const current = player.queue.current === null ? null : fromLavalinkTrack(player.queue.current);
    const upcoming = player.queue.tracks.flatMap((track) =>
      "resolve" in track ? [] : [fromLavalinkTrack(track)]
    );
    await interaction.reply(formatQueue(current, upcoming));
  }

  async function handleAutoplay(interaction: ChatInputCommandInteraction): Promise<void> {
    const voice = await getVoiceContext(interaction);
    if (!voice.ok) {
      await interaction.reply({ content: voice.message, flags: MessageFlags.Ephemeral });
      return;
    }
    const enabled = interaction.options.getString("모드", true) === "on";
    states.getOrCreate(interaction.guildId!).autoplayEnabled = enabled;
    if (enabled) {
      autoplayFailures.delete(interaction.guildId!);
    }
    await interaction.reply(`자동 추천 재생을 ${enabled ? "켰습니다" : "껐습니다"}.`);
  }

  async function handleStop(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = await requireControllablePlayer(interaction);
    if (player === undefined) return;
    await player.stopPlaying(true, false);
    await player.destroy("사용자가 정지 명령 실행");
    await interaction.reply("재생을 종료하고 음성 채널에서 나왔습니다.");
  }

  async function requireControllablePlayer(
    interaction: ChatInputCommandInteraction
  ): Promise<Player | undefined> {
    const player = lavalink.getPlayer(interaction.guildId!);
    const voice = await getVoiceContext(interaction);
    if (!voice.ok) {
      await interaction.reply({ content: voice.message, flags: MessageFlags.Ephemeral });
      return undefined;
    }
    if (player === undefined || player.queue.current === null) {
      await interaction.reply({
        content: "현재 재생 중인 곡이 없습니다.",
        flags: MessageFlags.Ephemeral
      });
      return undefined;
    }
    return player;
  }

  async function getVoiceContext(interaction: ChatInputCommandInteraction) {
    const member = await interaction.guild!.members.fetch(interaction.user.id);
    const voiceChannel = member.voice.channel;
    const player = lavalink.getPlayer(interaction.guildId!);
    const permissions = getBotVoicePermissions(voiceChannel);
    return validateVoiceAccess({
      botCanConnect: permissions.canConnect,
      botCanSpeak: permissions.canSpeak,
      memberChannelId: voiceChannel?.id ?? null,
      playerChannelId: player?.voiceChannelId ?? null
    });
  }

  function getBotVoicePermissions(channel: VoiceBasedChannel | null) {
    const botMember = channel?.guild.members.me;
    const permissions =
      channel === null || botMember === null || botMember === undefined
        ? undefined
        : channel.permissionsFor(botMember);
    return {
      canConnect: permissions?.has(PermissionFlagsBits.Connect) ?? false,
      canSpeak: permissions?.has(PermissionFlagsBits.Speak) ?? false
    };
  }

  async function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
    const player = lavalink.getPlayer(newState.guild.id);
    if (player?.voiceChannelId === null || player === undefined) {
      return;
    }
    if (oldState.channelId !== player.voiceChannelId && newState.channelId !== player.voiceChannelId) {
      return;
    }

    const channel = newState.guild.channels.cache.get(player.voiceChannelId);
    if (channel?.isVoiceBased() !== true) {
      return;
    }
    const humanCount = channel.members.filter((member) => !member.user.bot).size;
    if (humanCount === 0) {
      if (player.playing) {
        await player.pause();
        pausedForEmptyChannel.add(player.guildId);
      }
      schedulePlayerDestroy(player);
      return;
    }

    idleTimers.cancel(player.guildId);
    if (pausedForEmptyChannel.delete(player.guildId) && player.paused) {
      await player.resume();
    }
  }

  async function sendToPlayerChannel(player: Player, content: string): Promise<void> {
    if (player.textChannelId === null) {
      return;
    }
    const channel = await client.channels.fetch(player.textChannelId).catch(() => null);
    if (isSendableTextChannel(channel)) {
      await channel.send(content);
    }
  }

  return {
    client,
    lavalink,
    async start() {
      await client.login(config.DISCORD_TOKEN);
    }
  };
}

function isSendableTextChannel(channel: unknown): channel is SendableChannels {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "isSendable" in channel &&
    typeof channel.isSendable === "function" &&
    channel.isSendable()
  );
}

async function respondWithError(
  interaction: ChatInputCommandInteraction,
  error: unknown
): Promise<void> {
  const content = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ components: [], content });
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}

function formatMilliseconds(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function truncate(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
}
