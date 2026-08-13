import { randomUUID } from "node:crypto";

import {
  ActionRowBuilder,
  type AutocompleteInteraction,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  Client,
  ComponentType,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  type SendableChannels,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  type VoiceBasedChannel,
  type VoiceState
} from "discord.js";
import {
  LavalinkManager,
  type LavalinkNode,
  type NodeLinkNode,
  type Player,
  type Track
} from "lavalink-client";

import type { AppConfig } from "../config.js";
import { GuildStateStore } from "../domain/guild-state.js";
import type { MusicTrack } from "../domain/types.js";
import { HealthHeartbeat } from "../health/heartbeat.js";
import {
  fromLavalinkTrack,
  LavalinkTrackLoader
} from "../infrastructure/lavalink-track-loader.js";
import {
  DjEngineClient,
  type DjEnergyProfile
} from "../infrastructure/djengine-client.js";
import { LastFmGenreArtistProvider } from "../infrastructure/lastfm-genre-artist-provider.js";
import { MixIngestClient } from "../infrastructure/mix-ingest-client.js";
import { SqliteMusicRepository } from "../infrastructure/sqlite-music-repository.js";
import { AutoplayService } from "../music/autoplay-service.js";
import { DjMixPublisher } from "../music/dj-mix-publisher.js";
import { DjPlaybackService } from "../music/dj-playback-service.js";
import { DjStartReservations } from "../music/dj-start-reservations.js";
import { GuildRegistrySynchronizer } from "../music/guild-registry-synchronizer.js";
import { GenrePlaylistService } from "../music/genre-playlist.js";
import { GuildTaskQueue } from "../music/guild-task-queue.js";
import { IdleTimerManager } from "../music/idle-timer.js";
import {
  formatRepeatMode,
  moveQueuedTrack,
  parseSeekPosition,
  removeQueuedTrack,
  type PlaybackRepeatMode,
  validateSeekPosition
} from "../music/playback-controls.js";
import { restoreSavedTracks } from "../music/saved-playlist.js";
import { TrackResolverService } from "../music/track-resolver.js";
import { isDjInteractionAllowed } from "./dj-interaction-policy.js";
import { cleanupRemovedGuild } from "./guild-removal.js";
import { GenreDraftStore, type GenreDraft } from "./genre-draft.js";
import { createHelpReply } from "./help-view.js";
import {
  PlayerMessageController,
  type PlayerMessagePayload
} from "./player-message-controller.js";
import type { PlayerCardSnapshot } from "./player-view.js";
import { formatQueue } from "./queue-view.js";
import {
  validateVoiceAccess,
  validateVoiceMembership
} from "./voice-access.js";

const IDLE_TIMEOUT_MS = 300_000;
const MANUAL_QUEUE_LIMIT = 100;
const SEARCH_SELECTION_TIMEOUT_MS = 30_000;
const AUTOCOMPLETE_TIMEOUT_MS = 2_000;
const GENRE_DRAFT_TIMEOUT_MS = 600_000;
const GENRE_PAGE_SIZE = 10;
const GUILD_REGISTRY_SYNC_INTERVAL_MS = 60_000;

interface GenreDraftContext {
  interaction: ChatInputCommandInteraction;
  loader: LavalinkTrackLoader;
  missingCount: number;
  node: LavalinkNode | NodeLinkNode;
  nodeId: string;
  source: "curated" | "lastfm" | "youtube";
}

export interface MusicBot {
  client: Client;
  lavalink: LavalinkManager;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createMusicBot(config: AppConfig): MusicBot {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
  });
  const repository = new SqliteMusicRepository(config.DATABASE_PATH);
  const states = new GuildStateStore(repository);
  const idleTimers = new IdleTimerManager(IDLE_TIMEOUT_MS);
  const pausedForEmptyChannel = new Set<string>();
  const autoplayFailures = new Set<string>();
  const guildTasks = new GuildTaskQueue();
  const pendingDjStarts = new DjStartReservations<Player>();
  const genreDrafts = new GenreDraftStore<GenreDraftContext>({
    idFactory: randomUUID,
    ttlMs: GENRE_DRAFT_TIMEOUT_MS
  });
  const genreDraftTimeouts = new Map<string, NodeJS.Timeout>();
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  const genreArtistProvider =
    config.LASTFM_API_KEY === undefined
      ? undefined
      : new LastFmGenreArtistProvider({ apiKey: config.LASTFM_API_KEY });
  const djEngine =
    config.DJENGINE_BASE_URL === undefined || config.DJENGINE_API_KEY === undefined
      ? undefined
      : new DjEngineClient({
          apiKey: config.DJENGINE_API_KEY,
          baseUrl: config.DJENGINE_BASE_URL
        });
  const mixIngest =
    config.MIX_INGEST_URL === undefined ||
    config.MIX_INGEST_SECRET === undefined ||
    config.MIX_PUBLIC_URL === undefined
      ? undefined
      : new MixIngestClient({
          baseUrl: config.MIX_INGEST_URL,
          publicUrl: config.MIX_PUBLIC_URL,
          secret: config.MIX_INGEST_SECRET
        });
  const mixPublisher =
    djEngine === undefined || mixIngest === undefined
      ? undefined
      : new DjMixPublisher(djEngine, mixIngest);
  const djPlayback =
    djEngine === undefined ? undefined : new DjPlaybackService(djEngine, mixPublisher);
  const guildRegistry =
    mixIngest === undefined
      ? undefined
      : new GuildRegistrySynchronizer({
          intervalMs: GUILD_REGISTRY_SYNC_INTERVAL_MS,
          onError: (error) => {
            console.error("Discord 서버 목록을 mix 웹에 동기화하지 못했습니다.", error);
          },
          sync: () => mixIngest.syncGuilds(
            [...client.guilds.cache.values()]
              .map((guild) => ({ icon: guild.iconURL(), id: guild.id, name: guild.name }))
              .sort((left, right) => left.id.localeCompare(right.id))
          )
        });

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
  const healthHeartbeat = new HealthHeartbeat({
    isReady: () =>
      client.isReady() &&
      lavalink.nodeManager.nodes.get("local-lavalink")?.connected === true
  });

  const playerMessages = new PlayerMessageController({
    idFactory: randomUUID,
    send: async (channelId, payload) => {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!isSendableTextChannel(channel)) {
        throw new Error("플레이어 메시지를 보낼 수 있는 채널이 아닙니다.");
      }
      const message = await channel.send(payload);
      return {
        id: message.id,
        edit: async (nextPayload: PlayerMessagePayload) => {
          await message.edit(nextPayload);
        }
      };
    },
    snapshotProvider: (guildId) => createPlayerSnapshot(guildId),
    ...(config.KOFI_URL === undefined ? {} : { supportUrl: config.KOFI_URL })
  });

  async function enqueueRecommendation(player: Player, lastPlayedTrack: Track): Promise<void> {
    if (isDjEnginePlayer(player) || isDjEngineRawTrack(lastPlayedTrack)) {
      return;
    }
    const state = states.getOrCreate(player.guildId);
    if (!state.autoplayEnabled || manualQueueLength(player) > 0) {
      return;
    }

    try {
      const loader = new LavalinkTrackLoader(player);
      const service = new AutoplayService(loader);
      const feedbackProfile = repository.getRecommendationProfile(player.guildId);
      const recommended = await service.recommend({
        enabled: state.autoplayEnabled,
        excludedAuthors: feedbackProfile.blockedAuthors,
        excludedTrackIds: feedbackProfile.dislikedTrackIds,
        lastTrack: fromLavalinkTrack(lastPlayedTrack),
        ...(feedbackProfile.preferredTrack === undefined
          ? {}
          : { preferredSeed: feedbackProfile.preferredTrack }),
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

      await guildTasks.run(player.guildId, async () => {
        const latestState = states.getOrCreate(player.guildId);
        if (
          lavalink.getPlayer(player.guildId) !== player ||
          isDjModeActive(player.guildId) ||
          isDjEnginePlayer(player) ||
          !latestState.autoplayEnabled ||
          manualQueueLength(player) > 0
        ) {
          return;
        }
        autoplayFailures.delete(player.guildId);
        await player.queue.add(loader.toLavalinkTrack(recommended));
        await refreshPlayerMessage(player);
      });
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
    await refreshPlayerMessage(player);
  }

  function schedulePlayerDestroy(player: Player): void {
    idleTimers.schedule(player.guildId, async () => {
      await guildTasks.run(player.guildId, async () => {
        const current = lavalink.getPlayer(player.guildId);
        if (current !== player) {
          return;
        }
        await current.stopPlaying(true, false);
        await current.destroy("5분 동안 재생 요청 또는 청취자가 없어 자동 종료");
        await playerMessages.finish(player.guildId);
      });
    });
  }

  lavalink.on("trackStart", (player, track) => {
    if (track === null) {
      return;
    }
    idleTimers.cancel(player.guildId);
    autoplayFailures.delete(player.guildId);
    if (!isDjEnginePlayer(player)) {
      states.rememberTrack(player.guildId, track.info.identifier);
    }
    void refreshPlayerMessage(player);
  });

  lavalink.on("trackEnd", (player) => {
    void refreshPlayerMessage(player);
  });

  lavalink.on("trackError", (player, track, payload) => {
    if (isDjEnginePlayer(player)) {
      console.error(`DJ Engine 스트림 재생 오류: guild=${player.guildId}`);
      cleanupDjPlayerInBackground(player, "DJ Engine 스트림 재생 오류");
      return;
    }
    console.error(`트랙 재생 오류: ${track?.info.title ?? "알 수 없는 곡"}`, payload);
    void sendToPlayerChannel(player, "현재 곡을 재생하지 못해 다음 곡으로 넘어갑니다.");
    void refreshPlayerMessage(player);
  });

  lavalink.on("trackStuck", (player, track) => {
    if (isDjEnginePlayer(player)) {
      console.error(`DJ Engine 스트림 멈춤: guild=${player.guildId}`);
      cleanupDjPlayerInBackground(player, "DJ Engine 스트림 멈춤");
      return;
    }
    console.error(`트랙 멈춤: ${track?.info.title ?? "알 수 없는 곡"}`);
    void sendToPlayerChannel(player, "현재 곡의 재생이 멈춰 다음 곡으로 넘어갑니다.");
    void refreshPlayerMessage(player);
  });

  lavalink.on("queueEnd", (player) => {
    if (isDjEnginePlayer(player)) {
      cleanupDjPlayerInBackground(player, "DJ Engine 스트림 종료");
      return;
    }
    schedulePlayerDestroy(player);
    void refreshPlayerMessage(player);
  });

  lavalink.on("playerDestroy", (player) => {
    const replacement = lavalink.getPlayer(player.guildId);
    if (replacement !== undefined && replacement !== player) {
      return;
    }
    idleTimers.cancel(player.guildId);
    pausedForEmptyChannel.delete(player.guildId);
    autoplayFailures.delete(player.guildId);
    states.resetSession(player.guildId);
    void djPlayback?.closeGuild(player.guildId, player).catch((error: unknown) => {
      console.error(`DJ Engine 세션 정리에 실패했습니다: guild=${player.guildId}`, error);
    });
    void playerMessages.finish(player.guildId).catch((error: unknown) => {
      console.error("종료된 플레이어 메시지를 갱신하지 못했습니다.", error);
    });
  });

  client.on("raw", (payload) => {
    lavalink.sendRawData(payload);
  });

  client.on("voiceStateUpdate", (oldState, newState) => {
    void handleVoiceStateUpdate(oldState, newState).catch((error: unknown) => {
      console.error(`음성 채널 상태 처리에 실패했습니다: guild=${newState.guild.id}`, error);
    });
  });

  client.on("interactionCreate", (interaction) => {
    if (interaction.isAutocomplete()) {
      void handleDjAutocomplete(interaction).catch(async (error: unknown) => {
        console.error("DJ Engine 자동완성 처리 중 오류가 발생했습니다.", error);
        await interaction.respond([]).catch(() => undefined);
      });
      return;
    }

    if (interaction.isChatInputCommand()) {
      void handleCommand(interaction).catch(async (error: unknown) => {
        console.error("명령 처리 중 오류가 발생했습니다.", error);
        await respondWithError(interaction, error);
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("music:")) {
      void handlePlayerButton(interaction).catch(async (error: unknown) => {
        console.error("플레이어 버튼 처리 중 오류가 발생했습니다.", error);
        await respondToComponentError(interaction, error);
      });
      return;
    }

    if (
      (interaction.isButton() || interaction.isStringSelectMenu()) &&
      interaction.customId.startsWith("genre:")
    ) {
      void handleGenreComponent(interaction).catch(async (error: unknown) => {
        console.error("장르 미리보기 처리 중 오류가 발생했습니다.", error);
        await respondToComponentError(interaction, error);
      });
    }
  });

  client.once(Events.ClientReady, async (readyClient) => {
    await lavalink.init({ id: readyClient.user.id, username: readyClient.user.username });
    await guildRegistry?.trigger();
    guildRegistry?.start();
    console.info(`${readyClient.user.tag} 계정으로 로그인했습니다.`);
  });

  client.on(Events.GuildCreate, () => void guildRegistry?.trigger());
  client.on(Events.GuildDelete, (guild) => {
    // 큐에 들어가기 전에 취소 표시를 남겨 진행 중인 `/디제이 시작`이 다음 경계에서 멈추게 합니다.
    pendingDjStarts.cancel(guild.id);
    // 재생 정리가 오래 걸려도 웹 권한 교집합에서는 제거된 서버를 즉시 제외합니다.
    void guildRegistry?.trigger();
    void cleanupDeletedGuild(guild.id).catch((error: unknown) => {
      console.error(`제거된 Discord 서버 정리에 실패했습니다: guild=${guild.id}`, error);
    });
  });

  async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (stopping) {
      await interaction.reply({
        content: "봇이 종료 중입니다. 잠시 후 다시 시도해주세요.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    if (interaction.guild === null || interaction.guildId === null) {
      await interaction.reply({
        content: "Discord 서버 안에서만 사용할 수 있습니다.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (
      isDjModeActive(interaction.guildId) &&
      !isDjInteractionAllowed({
        commandName: interaction.commandName,
        kind: "command"
      })
    ) {
      await interaction.reply({
        content: "DJ 믹스 중에는 `/디제이` 제어와 `/볼륨`만 사용할 수 있습니다.",
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
      case "반복":
        await handleRepeat(interaction);
        break;
      case "셔플":
        await handleShuffle(interaction);
        break;
      case "삭제":
        await handleRemove(interaction);
        break;
      case "이동":
        await handleMove(interaction);
        break;
      case "탐색":
        await handleSeek(interaction);
        break;
      case "볼륨":
        await handleVolume(interaction);
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
      case "장르":
        await handleGenre(interaction);
        break;
      case "디제이":
        await handleDj(interaction);
        break;
      case "설정":
        await handleSettings(interaction);
        break;
      case "좋아요":
        await handleFavorite(interaction);
        break;
      case "내음악":
        await handleMyMusic(interaction);
        break;
      case "플레이리스트":
        await handlePlaylist(interaction);
        break;
      case "사용법":
        await interaction.reply(createHelpReply());
        break;
      default:
        await interaction.reply({
          content: "지원하지 않는 명령입니다.",
          flags: MessageFlags.Ephemeral
        });
    }
  }

  async function handleDjAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    if (
      stopping ||
      interaction.guildId === null ||
      interaction.commandName !== "디제이" ||
      djPlayback === undefined
    ) {
      await interaction.respond([]);
      return;
    }
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "플레이리스트") {
      await interaction.respond([]);
      return;
    }
    const query = String(focused.value).trim().toLocaleLowerCase("ko");
    const response = await resolveBefore(
      djPlayback.listPlaylists(),
      AUTOCOMPLETE_TIMEOUT_MS
    );
    if (response === undefined) {
      await interaction.respond([]);
      return;
    }
    const playlists = Array.isArray(response) ? response : response.data;
    const choices = playlists
      .filter(({ id, name }) =>
        id.length <= 100 &&
        (query === "" ||
          id.toLocaleLowerCase("ko").includes(query) ||
          name.toLocaleLowerCase("ko").includes(query))
      )
      .slice(0, 25)
      .map(({ id, name }) => ({ name: truncate(name, 100), value: id }));
    await interaction.respond(choices);
  }

  async function cleanupDeletedGuild(guildId: string): Promise<void> {
    try {
      await guildTasks.run(guildId, async () => {
        const activePlayer = lavalink.getPlayer(guildId);
        const pendingPlayer = pendingDjStarts.get(guildId)?.player;
        await cleanupRemovedGuild({
          ...(activePlayer === undefined ? {} : { activePlayer }),
          closePlayback: async (player) => {
            if (djPlayback === undefined) {
              await player?.destroy("Discord 서버에서 봇이 제거됨");
              return;
            }
            const failures: unknown[] = [];
            if (player === undefined) {
              await djPlayback.closeGuild(guildId).catch((error: unknown) => {
                failures.push(error);
              });
            } else {
              await djPlayback.stop(guildId, player).catch((error: unknown) => {
                failures.push(error);
              });
              // stop 내부 정리 일부가 실패해도 엔진/publisher DELETE를 한 번 더 시도합니다.
              await djPlayback.closeGuild(guildId, player).catch((error: unknown) => {
                failures.push(error);
              });
            }
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) {
              throw new AggregateError(failures, "DJ Engine 길드 정리에 실패했습니다.");
            }
          },
          finishPlayerMessage: () => playerMessages.finish(guildId),
          ...(pendingPlayer === undefined ? {} : { pendingPlayer })
        });
      });
    } finally {
      // 정리 중 서버 목록이 또 바뀌었을 수 있으므로 완료 시점에도 최신 cache를 보냅니다.
      await guildRegistry?.trigger();
    }
  }

  async function handlePlay(interaction: ChatInputCommandInteraction): Promise<void> {
    if (isDjModeActive(interaction.guildId!)) {
      await interaction.reply({
        content: "DJ Engine 자동 믹스가 재생 중입니다. 먼저 `/디제이 종료`를 사용해주세요.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const voice = await getVoiceContext(interaction);
    if (!voice.ok) {
      await interaction.reply({ content: voice.message, flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply();
    const guildId = interaction.guildId!;
    const searchContext = getSearchContext(guildId);
    const loader = searchContext.loader;
    const resolver = new TrackResolverService(loader);
    const query = interaction.options.getString("검색어", true);

    const resolved = await resolver.resolve(query, interaction.user.id);
    let selectedTracks = resolved.tracks;

    if (resolved.kind === "selection") {
      const selected = await selectSearchResult(interaction, resolved.tracks);
      if (selected === undefined) {
        return;
      }
      selectedTracks = [selected];
    }

    const added = await guildTasks.run(guildId, async () => {
      if (isDjModeActive(guildId)) {
        throw new Error("DJ Engine 자동 믹스가 재생 중입니다. 먼저 `/디제이 종료`를 사용해주세요.");
      }
      const latestVoice = await getVoiceContext(interaction);
      if (!latestVoice.ok) {
        throw new Error(latestVoice.message);
      }
      const player =
        lavalink.getPlayer(guildId) ??
        lavalink.createPlayer({
          guildId,
          node: searchContext.node,
          selfDeaf: true,
          selfMute: false,
          textChannelId: interaction.channelId,
          voiceChannelId: latestVoice.voiceChannelId,
          volume: states.getOrCreate(guildId).defaultVolume
        });
      const availableSlots = Math.max(0, MANUAL_QUEUE_LIMIT - manualQueueLength(player));
      const accepted = selectedTracks.slice(0, availableSlots);
      if (accepted.length === 0) {
        return { accepted: 0, player, skipped: resolved.skipped + selectedTracks.length };
      }

      idleTimers.cancel(player.guildId);
      if (!player.connected) {
        await player.connect();
      }
      await player.queue.add(accepted.map((track) => loader.toLavalinkTrack(track)));
      if (!player.playing && !player.paused && player.queue.current === null) {
        await player.play();
      }
      await refreshPlayerMessage(player, interaction.channelId);
      return {
        accepted: accepted.length,
        player,
        skipped: resolved.skipped + selectedTracks.length - accepted.length
      };
    });

    if (added.accepted === 0) {
      await interaction.editReply("대기열이 100곡으로 가득 찼습니다.");
      return;
    }

    const skipText = added.skipped > 0 ? ` 제한으로 ${added.skipped}곡은 제외했습니다.` : "";
    const unavailableText =
      resolved.unavailable > 0
        ? ` 삭제·비공개 등 재생할 수 없는 ${resolved.unavailable}곡은 제외했습니다.`
        : "";
    await interaction.editReply(
      `대기열에 ${added.accepted}곡을 추가했습니다.${skipText}${unavailableText}`
    );
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

  async function handleGenre(interaction: ChatInputCommandInteraction): Promise<void> {
    if (isDjModeActive(interaction.guildId!)) {
      await interaction.reply({
        content: "DJ Engine 자동 믹스가 재생 중입니다. 먼저 `/디제이 종료`를 사용해주세요.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const voice = await getVoiceContext(interaction);
    if (!voice.ok) {
      await interaction.reply({ content: voice.message, flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guildId!;
    const genre = interaction.options.getString("이름", true);
    const count = interaction.options.getInteger("곡수") ?? 20;
    const searchContext = getSearchContext(guildId);
    const service = new GenrePlaylistService(searchContext.loader, genreArtistProvider);
    const generated = await service.generate({
      count,
      excludedTrackIds: collectExcludedTrackIds(guildId),
      genre,
      requesterId: interaction.user.id
    });

    if (generated.tracks.length === 0) {
      throw new Error("현재 재생 기록과 대기열을 제외하면 추가할 새 곡이 없습니다.");
    }

    const created = genreDrafts.create({
      context: {
        interaction,
        loader: searchContext.loader,
        missingCount: generated.missingCount,
        node: searchContext.node,
        nodeId: searchContext.node.options.id ?? "local-lavalink",
        source: generated.source
      },
      guildId,
      now: Date.now(),
      tracks: generated.tracks,
      userId: interaction.user.id
    });

    if (created.replaced !== undefined) {
      clearGenreDraftTimeout(created.replaced);
      await disableGenreDraft(created.replaced, "새 장르 요청으로 이 미리보기가 취소되었습니다.");
    }
    scheduleGenreDraftExpiration(created.draft);
    await interaction.editReply(renderGenreDraft(created.draft));
  }

  async function handleDj(interaction: ChatInputCommandInteraction): Promise<void> {
    if (djPlayback === undefined) {
      await interaction.reply({
        content: "DJ Engine이 설정되지 않았습니다. 운영자에게 문의해주세요.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand(true);
    if (subcommand === "목록") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const response = await djPlayback.listPlaylists();
      const playlists = Array.isArray(response) ? response : response.data;
      if (playlists.length === 0) {
        await interaction.editReply("DJ Engine에서 사용할 수 있는 플레이리스트가 없습니다.");
        return;
      }
      const visible = playlists.slice(0, 15);
      const lines = visible.map(
        ({ id, name }, index) =>
          `${index + 1}. **${escapeMarkdown(truncate(name, 64))}** · ${formatInlineCode(id)}`
      );
      const remaining = playlists.length - visible.length;
      await interaction.editReply(
        `DJ Engine 플레이리스트\n${lines.join("\n")}${remaining > 0 ? `\n그 외 ${remaining}개` : ""}\n\nID를 \`/디제이 시작\`의 플레이리스트에 입력하세요.`
      );
      return;
    }

    if (subcommand !== "시작") {
      if (!isDjModeActive(interaction.guildId!)) {
        await interaction.reply({
          content: "현재 실행 중인 DJ 믹스가 없습니다.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      if (
        subcommand !== "종료" &&
        pendingDjStarts.has(interaction.guildId!) &&
        !djPlayback.isActive(interaction.guildId!)
      ) {
        await interaction.reply({
          content: "DJ 믹스를 시작하는 중입니다. 잠시 후 다시 시도하거나 `/디제이 종료`를 사용해주세요.",
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      switch (subcommand) {
        case "일시정지":
          await handlePause(interaction);
          return;
        case "계속":
          await handleResume(interaction);
          return;
        case "스킵":
          await handleSkip(interaction);
          return;
        case "종료":
          await handleStop(interaction);
          return;
        default:
          throw new Error("지원하지 않는 DJ 제어입니다.");
      }
    }

    // Discord는 interaction을 약 3초 안에 확인해야 하므로 엔진/음성 네트워크 작업 전에 응답을 예약합니다.
    await interaction.deferReply();
    const guildId = interaction.guildId!;
    if (isDjModeActive(guildId) || lavalink.getPlayer(guildId) !== undefined) {
      throw new Error("이미 재생 세션이 있습니다. 먼저 재생을 종료해주세요.");
    }
    // 네트워크 조회보다 먼저 예약해야 바로 이어진 `/디제이 종료`가 시작 요청을 취소할 수 있습니다.
    const reservation = pendingDjStarts.reserve(guildId, interaction.user.id);
    let player: Player | undefined;
    try {
      const playlistId = interaction.options.getString("플레이리스트", true);
      const energyValue = interaction.options.getString("에너지") ?? "build";
      if (!isDjEnergyProfile(energyValue)) {
        throw new Error("지원하지 않는 DJ 에너지 흐름입니다.");
      }
      const maxDurationMinutes = interaction.options.getInteger("시간") ?? 60;
      const playlistsResponse = await djPlayback.listPlaylists();
      if (reservation.cancelled) {
        throw new Error("DJ Engine 세션 시작이 취소되었습니다.");
      }
      const playlists = Array.isArray(playlistsResponse)
        ? playlistsResponse
        : playlistsResponse.data;
      const playlist = playlists.find(({ id }) => id === playlistId);
      if (playlist === undefined) {
        throw new Error("DJ Engine 플레이리스트를 찾지 못했습니다. `/디제이 목록`에서 ID를 확인해주세요.");
      }

      player = await guildTasks.run(guildId, async () => {
        if (stopping) {
          throw new Error("봇이 종료 중입니다. 잠시 후 다시 시도해주세요.");
        }
        if (reservation.cancelled || pendingDjStarts.get(guildId) !== reservation) {
          throw new Error("DJ Engine 세션 시작이 취소되었습니다.");
        }
        if (lavalink.getPlayer(guildId) !== undefined || djPlayback.isActive(guildId)) {
          throw new Error("이미 재생 세션이 있습니다. 먼저 재생을 종료해주세요.");
        }
        const latestVoice = await getVoiceContext(interaction);
        if (!latestVoice.ok) {
          throw new Error(latestVoice.message);
        }
        if (reservation.cancelled || pendingDjStarts.get(guildId) !== reservation) {
          throw new Error("DJ Engine 세션 시작이 취소되었습니다.");
        }
        const searchContext = getSearchContext(guildId);
        const createdPlayer = lavalink.createPlayer({
          guildId,
          node: searchContext.node,
          selfDeaf: true,
          selfMute: false,
          textChannelId: interaction.channelId,
          voiceChannelId: latestVoice.voiceChannelId,
          volume: states.getOrCreate(guildId).defaultVolume
        });
        player = createdPlayer;
        if (!pendingDjStarts.attachPlayer(reservation, createdPlayer)) {
          await createdPlayer.destroy("DJ Engine 세션 시작 취소").catch(() => undefined);
          throw new Error("DJ Engine 세션 시작이 취소되었습니다.");
        }
        await createdPlayer.connect();
        if (
          reservation.cancelled ||
          pendingDjStarts.get(guildId) !== reservation ||
          lavalink.getPlayer(guildId) !== createdPlayer
        ) {
          throw new Error("DJ Engine 세션 시작이 취소되었습니다.");
        }
        await djPlayback.start({
          energyProfile: energyValue,
          guildId,
          idempotencyKey: `djscord_${guildId}_${interaction.id}`,
          maxDurationMinutes,
          ownerRef: `discord:guild:${guildId}`,
          player: createdPlayer,
          playlistId,
          playlistName: playlist.name,
          requesterId: interaction.user.id
        });

        const channel = interaction.guild!.channels.cache.get(latestVoice.voiceChannelId);
        const humanCount =
          channel?.isVoiceBased() === true
            ? channel.members.filter((member) => !member.user.bot).size
            : 0;
        await applyVoiceOccupancy(createdPlayer, humanCount);
        await refreshPlayerMessage(createdPlayer, interaction.channelId);
        return createdPlayer;
      });
      const mixUrl = djPlayback.getMixUrl(guildId);
      await interaction.editReply(
        `**${escapeMarkdown(truncate(playlist.name, 180))}** DJ 믹스를 시작했습니다. · ${maxDurationMinutes}분 · ${formatDjEnergy(energyValue)}` +
          (mixUrl === undefined ? "" : `\n믹싱 화면: ${mixUrl}`)
      );
    } catch (error) {
      if (player !== undefined) {
        await djPlayback.closeGuild(guildId, player).catch(() => undefined);
        if (lavalink.getPlayer(guildId) === player) {
          await player.destroy("DJ Engine 세션 시작 실패").catch(() => undefined);
        }
      }
      throw sanitizeDjStartError(error);
    } finally {
      const unownedPlayerStillPresent =
        player !== undefined &&
        lavalink.getPlayer(guildId) === player &&
        !djPlayback.ownsPlayer(guildId, player);
      // destroy가 실패해 고아 player가 남았다면 예약을 tombstone으로 유지해 재사용을 막습니다.
      if (!unownedPlayerStillPresent) pendingDjStarts.release(reservation);
    }
  }

  async function handleGenreComponent(
    interaction: ButtonInteraction | StringSelectMenuInteraction
  ): Promise<void> {
    await interaction.deferUpdate();
    if (interaction.guildId === null) {
      await interaction.followUp({
        content: "Discord 서버 안에서만 사용할 수 있습니다.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    if (
      isDjModeActive(interaction.guildId) &&
      !isDjInteractionAllowed({ action: interaction.customId, kind: "component" })
    ) {
      await interaction.followUp({
        content: "DJ 믹스 중에는 장르 미리보기 버튼을 사용할 수 없습니다.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const parsed = parseGenreCustomId(interaction.customId);
    const draft =
      parsed === undefined
        ? undefined
        : genreDrafts.find(
            interaction.guildId,
            interaction.user.id,
            parsed.draftId,
            parsed.revision,
            Date.now()
          );
    if (parsed === undefined || draft === undefined) {
      await interaction.followUp({
        content: "만료되었거나 이미 변경된 장르 미리보기입니다.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (parsed.action === "select") {
      if (!interaction.isStringSelectMenu()) {
        throw new Error("잘못된 장르 선택 요청입니다.");
      }
      const updated = genreDrafts.setSelection(draft, interaction.values, Date.now());
      await interaction.editReply(renderGenreDraft(updated));
      return;
    }
    if (!interaction.isButton()) {
      throw new Error("잘못된 장르 미리보기 버튼입니다.");
    }

    switch (parsed.action) {
      case "previous": {
        const updated = genreDrafts.setPage(draft, draft.page - 1, Date.now());
        await interaction.editReply(renderGenreDraft(updated));
        return;
      }
      case "next": {
        const updated = genreDrafts.setPage(draft, draft.page + 1, Date.now());
        await interaction.editReply(renderGenreDraft(updated));
        return;
      }
      case "remove": {
        const updated = genreDrafts.removeSelected(draft, Date.now());
        await interaction.editReply(renderGenreDraft(updated));
        return;
      }
      case "confirm":
        await confirmGenreDraft(interaction, draft);
        return;
      case "cancel":
        genreDrafts.cancel(draft);
        clearGenreDraftTimeout(draft);
        await interaction.editReply(
          renderGenreDraft(draft, { disabled: true, notice: "장르 플레이리스트 생성을 취소했습니다." })
        );
        return;
      default:
        throw new Error("지원하지 않는 장르 미리보기 작업입니다.");
    }
  }

  async function confirmGenreDraft(
    interaction: ButtonInteraction,
    draft: GenreDraft<GenreDraftContext>
  ): Promise<void> {
    const result = await guildTasks.run(draft.guildId, async () => {
      if (isDjModeActive(draft.guildId)) {
        throw new Error("DJ Engine 자동 믹스가 재생 중입니다. 먼저 `/디제이 종료`를 사용해주세요.");
      }
      const voice = await getVoiceContext(interaction);
      if (!voice.ok) {
        throw new Error(voice.message);
      }
      const consumed = genreDrafts.consume(draft, Date.now());
      if (consumed === undefined) {
        throw new Error("이미 확정되었거나 만료된 장르 미리보기입니다.");
      }
      clearGenreDraftTimeout(consumed);

      const excluded = collectExcludedTrackIds(draft.guildId);
      const candidates = consumed.tracks.filter(({ identifier }) => !excluded.has(identifier));
      const currentPlayer = lavalink.getPlayer(draft.guildId);
      const slots = Math.max(
        0,
        MANUAL_QUEUE_LIMIT - (currentPlayer === undefined ? 0 : manualQueueLength(currentPlayer))
      );
      const accepted = candidates.slice(0, slots);
      if (accepted.length === 0) {
        return {
          added: 0,
          excluded: consumed.tracks.length,
          player: currentPlayer
        };
      }

      const player =
        currentPlayer ??
        lavalink.createPlayer({
          guildId: draft.guildId,
          node: consumed.context.node,
          selfDeaf: true,
          selfMute: false,
          textChannelId: consumed.context.interaction.channelId,
          voiceChannelId: voice.voiceChannelId,
          volume: states.getOrCreate(draft.guildId).defaultVolume
        });
      idleTimers.cancel(player.guildId);
      if (!player.connected) {
        await player.connect();
      }
      await player.queue.add(
        accepted.map((track) => consumed.context.loader.toLavalinkTrack(track))
      );
      if (!player.playing && !player.paused && player.queue.current === null) {
        await player.play();
      }
      await refreshPlayerMessage(player, consumed.context.interaction.channelId);
      return {
        added: accepted.length,
        excluded: consumed.tracks.length - accepted.length,
        player
      };
    });

    const notice =
      result.added === 0
        ? "대기열이 가득 찼거나 미리보기 동안 같은 곡이 추가되어 넣을 곡이 없습니다."
        : `장르 플레이리스트 ${result.added}곡을 대기열에 추가했습니다.${
            result.excluded > 0 ? ` 중복·용량 제한으로 ${result.excluded}곡은 제외했습니다.` : ""
          }`;
    await interaction.editReply(renderGenreDraft(draft, { disabled: true, notice }));
  }

  function renderGenreDraft(
    draft: GenreDraft<GenreDraftContext>,
    options: { disabled?: boolean; notice?: string } = {}
  ) {
    const disabled = options.disabled ?? false;
    const pageCount = Math.max(1, Math.ceil(draft.tracks.length / GENRE_PAGE_SIZE));
    const pageTracks = draft.tracks.slice(
      draft.page * GENRE_PAGE_SIZE,
      (draft.page + 1) * GENRE_PAGE_SIZE
    );
    const description =
      pageTracks.length === 0
        ? "남아 있는 곡이 없습니다."
        : pageTracks
            .map(
              (track, index) =>
                `${draft.page * GENRE_PAGE_SIZE + index + 1}. [${escapeLinkText(track.title)}](${track.uri}) · ${track.author} · ${formatMilliseconds(track.durationMs)}`
            )
            .join("\n");
    const embed = new EmbedBuilder()
      .setColor(0x8b5cf6)
      .setTitle("장르 플레이리스트 미리보기")
      .setDescription(description)
      .addFields(
        { name: "페이지", value: `${draft.page + 1} / ${pageCount}`, inline: true },
        { name: "남은 곡", value: `${draft.tracks.length}곡`, inline: true },
        { name: "제거 선택", value: `${draft.selectedTrackIds.size}곡`, inline: true },
        ...(draft.context.source === "lastfm"
          ? [
              {
                name: "대표 아티스트 데이터",
                value: "[Last.fm](https://www.last.fm/)",
                inline: true
              }
            ]
          : [])
      );
    if (draft.context.missingCount > 0) {
      embed.setFooter({
        text: `요청한 수보다 후보가 부족해 ${draft.context.missingCount}곡 적게 찾았습니다.`
      });
    }

    const select = new StringSelectMenuBuilder()
      .setCustomId(genreCustomId(draft, "select"))
      .setPlaceholder("현재 페이지에서 제거할 곡을 선택하세요.")
      .setDisabled(disabled || pageTracks.length === 0)
      .setMinValues(0)
      .setMaxValues(Math.max(1, pageTracks.length))
      .addOptions(
        pageTracks.length === 0
          ? [{ label: "남아 있는 곡 없음", value: "none" }]
          : pageTracks.map((track) => ({
              default: draft.selectedTrackIds.has(track.identifier),
              description: truncate(`${track.author} · ${formatMilliseconds(track.durationMs)}`, 100),
              label: truncate(track.title, 100),
              value: track.identifier
            }))
      );
    const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      genreButton(draft, "previous", "이전", ButtonStyle.Secondary, disabled || draft.page === 0),
      genreButton(
        draft,
        "next",
        "다음",
        ButtonStyle.Secondary,
        disabled || draft.page >= pageCount - 1
      ),
      genreButton(
        draft,
        "remove",
        "선택 제거",
        ButtonStyle.Danger,
        disabled || draft.selectedTrackIds.size === 0
      ),
      genreButton(
        draft,
        "confirm",
        "확정",
        ButtonStyle.Success,
        disabled || draft.tracks.length === 0
      ),
      genreButton(draft, "cancel", "취소", ButtonStyle.Secondary, disabled)
    );

    return {
      components: [selectRow, buttonRow],
      content: options.notice ?? "제거할 곡을 선택한 뒤 `선택 제거`를 누르거나 그대로 확정하세요.",
      embeds: [embed]
    };
  }

  function scheduleGenreDraftExpiration(draft: GenreDraft<GenreDraftContext>): void {
    const key = genreDraftKey(draft.guildId, draft.userId);
    const timeout = setTimeout(() => {
      const current = genreDrafts.getCurrent(
        draft.guildId,
        draft.userId,
        draft.expiresAt - 1
      );
      if (current?.id !== draft.id) {
        return;
      }
      genreDrafts.cancel(current);
      genreDraftTimeouts.delete(key);
      void disableGenreDraft(current, "10분이 지나 장르 미리보기가 만료되었습니다.");
    }, GENRE_DRAFT_TIMEOUT_MS);
    timeout.unref();
    genreDraftTimeouts.set(key, timeout);
  }

  function clearGenreDraftTimeout(draft: GenreDraft<GenreDraftContext>): void {
    const key = genreDraftKey(draft.guildId, draft.userId);
    const timeout = genreDraftTimeouts.get(key);
    if (timeout !== undefined) {
      clearTimeout(timeout);
      genreDraftTimeouts.delete(key);
    }
  }

  async function disableGenreDraft(
    draft: GenreDraft<GenreDraftContext>,
    notice: string
  ): Promise<void> {
    await draft.context.interaction
      .editReply(renderGenreDraft(draft, { disabled: true, notice }))
      .catch(() => undefined);
  }

  async function handlePause(interaction: ChatInputCommandInteraction): Promise<void> {
    if (djPlayback?.isActive(interaction.guildId!) === true) {
      await interaction.deferReply();
    }
    const player = await requireControllablePlayer(interaction);
    if (player === undefined) return;
    if (djPlayback?.isActive(player.guildId) === true) {
      if (djPlayback.isPaused(player.guildId)) {
        await replyCommand(interaction, "이미 일시정지 상태입니다.", true);
        return;
      }
      await guildTasks.run(player.guildId, async () => {
        await djPlayback.pause(player.guildId, interaction.id);
        await refreshPlayerMessage(player);
      });
      await replyCommand(interaction, "DJ 믹스를 일시정지했습니다.");
      return;
    }
    if (player.paused) {
      await replyCommand(interaction, "이미 일시정지 상태입니다.", true);
      return;
    }
    await guildTasks.run(player.guildId, async () => {
      await player.pause();
      await refreshPlayerMessage(player);
    });
    await replyCommand(interaction, "재생을 일시정지했습니다.");
  }

  async function handleResume(interaction: ChatInputCommandInteraction): Promise<void> {
    if (djPlayback?.isActive(interaction.guildId!) === true) {
      await interaction.deferReply();
    }
    const player = await requireControllablePlayer(interaction);
    if (player === undefined) return;
    if (djPlayback?.isActive(player.guildId) === true) {
      if (!djPlayback.isPaused(player.guildId)) {
        await replyCommand(interaction, "일시정지된 DJ 믹스가 없습니다.", true);
        return;
      }
      await guildTasks.run(player.guildId, async () => {
        idleTimers.cancel(player.guildId);
        await djPlayback.resume(player.guildId, interaction.id);
        await refreshPlayerMessage(player);
      });
      await replyCommand(interaction, "DJ 믹스를 계속합니다.");
      return;
    }
    if (!player.paused) {
      await replyCommand(interaction, "일시정지된 곡이 없습니다.", true);
      return;
    }
    await guildTasks.run(player.guildId, async () => {
      pausedForEmptyChannel.delete(player.guildId);
      idleTimers.cancel(player.guildId);
      await player.resume();
      await refreshPlayerMessage(player);
    });
    await replyCommand(interaction, "재생을 계속합니다.");
  }

  async function handleSkip(interaction: ChatInputCommandInteraction): Promise<void> {
    if (djPlayback?.isActive(interaction.guildId!) === true) {
      await interaction.deferReply();
    }
    const player = await requireControllablePlayer(interaction);
    if (player === undefined) return;
    await guildTasks.run(player.guildId, async () => {
      if (djPlayback?.isActive(player.guildId) === true) {
        await djPlayback.skip(player.guildId, interaction.id);
      } else {
        await player.skip(0, false);
      }
      await refreshPlayerMessage(player);
    });
    await replyCommand(interaction, "현재 곡을 건너뛰었습니다.");
  }

  async function handleRepeat(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = await requireControllablePlayer(interaction);
    if (player === undefined) return;
    if (await rejectUnsupportedDjControl(interaction, player, "반복")) return;
    const mode = interaction.options.getString("모드", true);
    if (!isPlaybackRepeatMode(mode)) {
      throw new Error("지원하지 않는 반복 모드입니다.");
    }
    await guildTasks.run(player.guildId, async () => {
      await player.setRepeatMode(mode);
      await refreshPlayerMessage(player);
    });
    await interaction.reply(`반복 모드를 **${formatRepeatMode(mode)}**으로 설정했습니다.`);
  }

  async function handleShuffle(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = await requireControllablePlayer(interaction);
    if (player === undefined) return;
    if (await rejectUnsupportedDjControl(interaction, player, "셔플")) return;
    if (player.queue.tracks.length < 2) {
      await interaction.reply({
        content: "순서를 섞으려면 대기열에 다음 곡이 2곡 이상 있어야 합니다.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    await guildTasks.run(player.guildId, async () => {
      await player.queue.shuffle();
      await refreshPlayerMessage(player);
    });
    await interaction.reply(`다음 ${player.queue.tracks.length}곡의 순서를 섞었습니다.`);
  }

  async function handleRemove(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = await requireControllablePlayer(interaction);
    if (player === undefined) return;
    if (await rejectUnsupportedDjControl(interaction, player, "대기열 삭제")) return;
    const position = interaction.options.getInteger("번호", true);
    await guildTasks.run(player.guildId, async () => {
      await removeQueuedTrack(player.queue, position);
      await refreshPlayerMessage(player);
    });
    await interaction.reply(`대기열 ${position}번 곡을 삭제했습니다.`);
  }

  async function handleMove(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = await requireControllablePlayer(interaction);
    if (player === undefined) return;
    if (await rejectUnsupportedDjControl(interaction, player, "대기열 이동")) return;
    const fromPosition = interaction.options.getInteger("곡", true);
    const toPosition = interaction.options.getInteger("위치", true);
    await guildTasks.run(player.guildId, async () => {
      await moveQueuedTrack(player.queue, fromPosition, toPosition);
      await refreshPlayerMessage(player);
    });
    await interaction.reply(`대기열 ${fromPosition}번 곡을 ${toPosition}번 위치로 옮겼습니다.`);
  }

  async function handleSeek(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = await requireControllablePlayer(interaction);
    if (player === undefined || player.queue.current === null) return;
    if (await rejectUnsupportedDjControl(interaction, player, "탐색")) return;
    const positionMs = validateSeekPosition(
      fromLavalinkTrack(player.queue.current),
      parseSeekPosition(interaction.options.getString("시간", true))
    );
    await guildTasks.run(player.guildId, async () => {
      await player.seek(positionMs);
      await refreshPlayerMessage(player);
    });
    await interaction.reply(`재생 위치를 **${formatMilliseconds(positionMs)}**로 이동했습니다.`);
  }

  async function handleVolume(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    const player = await requireControllablePlayer(interaction);
    if (player === undefined) return;
    const volume = interaction.options.getInteger("값", true);
    await guildTasks.run(player.guildId, async () => {
      await player.setVolume(volume);
      await refreshPlayerMessage(player);
    });
    await replyCommand(interaction, `볼륨을 **${volume}%**로 설정했습니다.`);
  }

  async function handleQueue(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = lavalink.getPlayer(interaction.guildId!);
    if (player === undefined) {
      await interaction.reply("현재 재생 중인 곡이 없습니다.");
      return;
    }
    if (isDjEnginePlayer(player)) {
      await interaction.reply(
        formatQueue(djPlayback?.getDisplayTrack(interaction.guildId!) ?? createSafeDjTrack(), [])
      );
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
    const guildId = interaction.guildId!;
    const existingPlayer = lavalink.getPlayer(guildId);
    if (
      existingPlayer !== undefined &&
      await rejectUnsupportedDjControl(interaction, existingPlayer, "자동재생")
    ) return;
    const enabled = interaction.options.getString("모드", true) === "on";
    await guildTasks.run(guildId, async () => {
      if (isDjModeActive(guildId)) {
        throw new Error("DJ Engine 자동 믹스에서는 자동재생을 사용할 수 없습니다.");
      }
      states.getOrCreate(guildId).autoplayEnabled = enabled;
      if (enabled) {
        autoplayFailures.delete(guildId);
      }
      const player = lavalink.getPlayer(guildId);
      if (player !== undefined) {
        await refreshPlayerMessage(player);
      }
    });
    await interaction.reply(`자동 추천 재생을 ${enabled ? "켰습니다" : "껐습니다"}.`);
  }

  async function handleStop(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const djActive = isDjModeActive(guildId);
    if (djActive) {
      await interaction.deferReply();
    }
    const pendingStart = pendingDjStarts.get(guildId);
    const player = pendingStart === undefined
      ? lavalink.getPlayer(guildId)
      : pendingStart.player;
    if (djActive && djPlayback !== undefined) {
      if (pendingStart !== undefined && player === undefined) {
        if (pendingStart.requesterId !== interaction.user.id) {
          await replyCommand(
            interaction,
            "음성 채널을 확인하기 전에는 DJ 시작을 요청한 사용자만 취소할 수 있습니다.",
            true
          );
          return;
        }
        pendingDjStarts.cancel(guildId);
        await replyCommand(interaction, "DJ 믹스 시작 요청을 취소했습니다.");
        return;
      }
      const membership = await getVoiceMembership(interaction, player?.voiceChannelId ?? null);
      if (!membership.ok) {
        await replyCommand(interaction, membership.message, true);
        return;
      }
      pendingDjStarts.cancel(guildId);
      if (player === undefined) {
        await djPlayback.closeGuild(guildId);
      } else {
        await djPlayback.stop(guildId, player);
      }
      await playerMessages.finish(guildId);
      await replyCommand(interaction, "DJ 믹스를 종료하고 음성 채널에서 나왔습니다.");
      return;
    }

    const voice = await getVoiceContext(interaction);
    if (!voice.ok) {
      await replyCommand(interaction, voice.message, true);
      return;
    }
    if (player === undefined) {
      await replyCommand(interaction, "현재 재생 세션이 없습니다.", true);
      return;
    }
    await guildTasks.run(player.guildId, async () => {
      if (djPlayback?.isActive(player.guildId) === true) {
        await djPlayback.stop(player.guildId, player);
      } else {
        await player.stopPlaying(true, false);
        await player.destroy("사용자가 정지 명령 실행");
      }
      await playerMessages.finish(player.guildId);
    });
    await replyCommand(interaction, "재생을 종료하고 음성 채널에서 나왔습니다.");
  }

  async function handleSettings(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) !== true) {
      await interaction.reply({
        content: "서버 설정을 변경하려면 `서버 관리` 권한이 필요합니다.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const guildId = interaction.guildId!;
    const defaultVolume = interaction.options.getInteger("기본볼륨");
    const autoplayOption = interaction.options.getString("자동재생");
    const autoplayDefault =
      autoplayOption === null ? undefined : autoplayOption === "on";

    const state = await guildTasks.run(guildId, async () => {
      const updated = states.updateSettings(guildId, {
        ...(autoplayDefault === undefined ? {} : { autoplayDefault }),
        ...(defaultVolume === null ? {} : { defaultVolume })
      });
      const player = lavalink.getPlayer(guildId);
      if (player !== undefined) {
        if (defaultVolume !== null) {
          await player.setVolume(defaultVolume);
        }
        await refreshPlayerMessage(player);
      }
      return updated;
    });

    const changed = defaultVolume !== null || autoplayDefault !== undefined;
    await interaction.reply({
      content: `${changed ? "서버 음악 설정을 저장했습니다.\n" : "현재 서버 음악 설정입니다.\n"}기본 볼륨: **${state.defaultVolume}%**\n자동재생 기본값: **${state.autoplayDefault ? "켜기" : "끄기"}**`,
      flags: MessageFlags.Ephemeral
    });
  }

  async function handleFavorite(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = lavalink.getPlayer(interaction.guildId!);
    if (player?.queue.current === null || player?.queue.current === undefined) {
      await interaction.reply({
        content: "현재 재생 중인 곡이 없습니다.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    if (await rejectUnsupportedDjControl(interaction, player, "좋아요")) return;
    const track = fromLavalinkTrack(player.queue.current);
    const added = repository.addFavorite(interaction.user.id, track);
    await interaction.reply({
      content: added
        ? `즐겨찾기에 **${track.title}**을(를) 저장했습니다.`
        : `**${track.title}**은(는) 이미 즐겨찾기에 있습니다.`,
      flags: MessageFlags.Ephemeral
    });
  }

  async function handleMyMusic(interaction: ChatInputCommandInteraction): Promise<void> {
    const tracks = repository.listFavorites(interaction.user.id, 20);
    if (tracks.length === 0) {
      await interaction.reply({
        content: "저장한 즐겨찾기 곡이 없습니다. 재생 중에 `/좋아요`를 사용해보세요.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const content = tracks
      .map(
        (track, index) =>
          `${index + 1}. [${escapeLinkText(track.title)}](${track.uri}) · ${track.author}`
      )
      .join("\n");
    await interaction.reply({
      content: `**내 즐겨찾기 · 최근 ${tracks.length}곡**\n${content}`,
      flags: MessageFlags.Ephemeral
    });
  }

  async function handlePlaylist(interaction: ChatInputCommandInteraction): Promise<void> {
    const currentPlayer = lavalink.getPlayer(interaction.guildId!);
    const subcommand = interaction.options.getSubcommand(true);
    if (
      (subcommand === "저장" || subcommand === "재생") &&
      currentPlayer !== undefined &&
      isDjEnginePlayer(currentPlayer)
    ) {
      await interaction.reply({
        content:
          subcommand === "저장"
            ? "DJ Engine 자동 믹스는 플레이리스트에 저장할 수 없습니다."
            : "DJ Engine 자동 믹스가 재생 중입니다. 먼저 `/디제이 종료`를 사용해주세요.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    switch (subcommand) {
      case "저장":
        await saveCurrentPlaylist(interaction);
        return;
      case "목록":
        await listSavedPlaylists(interaction);
        return;
      case "재생":
        await playSavedPlaylist(interaction);
        return;
      case "삭제":
        await deleteSavedPlaylist(interaction);
        return;
      default:
        throw new Error("지원하지 않는 플레이리스트 작업입니다.");
    }
  }

  async function saveCurrentPlaylist(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const player = lavalink.getPlayer(interaction.guildId!);
    if (player === undefined) {
      await interaction.reply({
        content: "저장할 현재 곡이나 대기열이 없습니다.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const tracks = [
      ...(player.queue.current === null ? [] : [fromLavalinkTrack(player.queue.current)]),
      ...player.queue.tracks.flatMap((track) =>
        "resolve" in track ? [] : [fromLavalinkTrack(track)]
      )
    ].slice(0, MANUAL_QUEUE_LIMIT);
    if (tracks.length === 0) {
      await interaction.reply({
        content: "저장할 현재 곡이나 대기열이 없습니다.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    const name = interaction.options.getString("이름", true);
    const status = repository.savePlaylist(
      interaction.guildId!,
      interaction.user.id,
      name,
      tracks
    );
    await interaction.reply({
      content: `플레이리스트 ${formatInlineCode(name)}에 ${tracks.length}곡을 ${status === "created" ? "저장했습니다" : "새 목록으로 교체했습니다"}.`,
      flags: MessageFlags.Ephemeral
    });
  }

  async function listSavedPlaylists(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const playlists = repository.listPlaylists(interaction.guildId!, interaction.user.id);
    const content =
      playlists.length === 0
        ? "저장한 플레이리스트가 없습니다."
        : playlists
            .map(
              ({ name, trackCount }, index) =>
                `${index + 1}. ${formatInlineCode(name)} · ${trackCount}곡`
            )
            .join("\n");
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }

  async function deleteSavedPlaylist(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const name = interaction.options.getString("이름", true);
    const deleted = repository.deletePlaylist(
      interaction.guildId!,
      interaction.user.id,
      name
    );
    await interaction.reply({
      content: deleted
        ? `플레이리스트 ${formatInlineCode(name)}을(를) 삭제했습니다.`
        : `플레이리스트 ${formatInlineCode(name)}을(를) 찾지 못했습니다.`,
      flags: MessageFlags.Ephemeral
    });
  }

  async function playSavedPlaylist(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const voice = await getVoiceContext(interaction);
    if (!voice.ok) {
      await interaction.reply({ content: voice.message, flags: MessageFlags.Ephemeral });
      return;
    }
    const name = interaction.options.getString("이름", true);
    const saved = repository.getPlaylist(interaction.guildId!, interaction.user.id, name);
    if (saved === undefined) {
      await interaction.reply({
        content: `플레이리스트 ${formatInlineCode(name)}을(를) 찾지 못했습니다.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guildId!;
    const searchContext = getSearchContext(guildId);
    const restored = await restoreSavedTracks(
      searchContext.loader,
      saved.tracks,
      interaction.user.id
    );
    const result = await guildTasks.run(guildId, async () => {
      if (isDjModeActive(guildId)) {
        throw new Error("DJ Engine 자동 믹스가 재생 중입니다. 먼저 `/디제이 종료`를 사용해주세요.");
      }
      const latestVoice = await getVoiceContext(interaction);
      if (!latestVoice.ok) throw new Error(latestVoice.message);
      const currentPlayer = lavalink.getPlayer(guildId);
      const slots = Math.max(
        0,
        MANUAL_QUEUE_LIMIT - (currentPlayer === undefined ? 0 : manualQueueLength(currentPlayer))
      );
      const accepted = restored.tracks.slice(0, slots);
      if (accepted.length === 0) return { added: 0, limited: restored.tracks.length };
      const player =
        currentPlayer ??
        lavalink.createPlayer({
          guildId,
          node: searchContext.node,
          selfDeaf: true,
          selfMute: false,
          textChannelId: interaction.channelId,
          voiceChannelId: latestVoice.voiceChannelId,
          volume: states.getOrCreate(guildId).defaultVolume
        });
      idleTimers.cancel(guildId);
      if (!player.connected) await player.connect();
      await player.queue.add(
        accepted.map((track) => searchContext.loader.toLavalinkTrack(track))
      );
      if (!player.playing && !player.paused && player.queue.current === null) {
        await player.play();
      }
      await refreshPlayerMessage(player, interaction.channelId);
      return { added: accepted.length, limited: restored.tracks.length - accepted.length };
    });

    if (result.added === 0) {
      await interaction.editReply("대기열이 가득 찼거나 저장된 곡을 다시 찾지 못했습니다.");
      return;
    }
    const excluded = restored.unavailableCount + result.limited;
    await interaction.editReply(
      `플레이리스트 ${formatInlineCode(saved.name)}에서 ${result.added}곡을 추가했습니다.${excluded > 0 ? ` 찾을 수 없거나 용량을 초과한 ${excluded}곡은 제외했습니다.` : ""}`
    );
  }

  async function handlePlayerButton(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (interaction.guildId === null) {
      await interaction.editReply("Discord 서버 안에서만 사용할 수 있습니다.");
      return;
    }
    const parsed = parsePlayerCustomId(interaction.customId);
    if (
      parsed === undefined ||
      !playerMessages.isCurrent(interaction.guildId, parsed.sessionId, interaction.message.id)
    ) {
      await interaction.editReply("만료된 플레이어입니다.");
      return;
    }

    if (
      isDjModeActive(interaction.guildId) &&
      !isDjInteractionAllowed({ action: parsed.action, kind: "component" })
    ) {
      await interaction.editReply(
        "DJ 믹스 중에는 플레이어 버튼을 사용할 수 없습니다. `/디제이` 명령으로 제어해주세요."
      );
      return;
    }

    if (parsed.action === "queue") {
      const player = lavalink.getPlayer(interaction.guildId);
      await interaction.editReply(formatPlayerQueue(player));
      return;
    }
    if (parsed.action === "refresh") {
      if (!playerMessages.tryRefresh(interaction.guildId, Date.now())) {
        await interaction.editReply("새로고침은 서버별로 5초에 한 번 사용할 수 있습니다.");
        return;
      }
      const player = lavalink.getPlayer(interaction.guildId);
      if (player === undefined) {
        await interaction.editReply("현재 재생 중인 곡이 없습니다.");
        return;
      }
      await refreshPlayerMessage(player, interaction.channelId);
      await interaction.editReply("플레이어를 최신 상태로 갱신했습니다.");
      return;
    }

    const voice = await getVoiceContext(interaction);
    if (!voice.ok) {
      await interaction.editReply(voice.message);
      return;
    }
    await guildTasks.run(interaction.guildId, async () => {
      const player = lavalink.getPlayer(interaction.guildId!);
      if (player === undefined) {
        throw new Error("현재 재생 중인 곡이 없습니다.");
      }

      switch (parsed.action) {
        case "toggle":
          if (player.queue.current === null) {
            throw new Error("현재 재생 중인 곡이 없습니다.");
          }
          if (isDjEnginePlayer(player)) {
            if (djPlayback === undefined || !djPlayback.isActive(player.guildId)) {
              throw new Error("DJ Engine 세션을 정리하고 있습니다.");
            }
            if (djPlayback.isPaused(player.guildId)) {
              await djPlayback.resume(player.guildId, randomUUID());
            } else {
              await djPlayback.pause(player.guildId, randomUUID());
            }
          } else if (player.paused) {
            pausedForEmptyChannel.delete(player.guildId);
            idleTimers.cancel(player.guildId);
            await player.resume();
          } else {
            await player.pause();
          }
          await refreshPlayerMessage(player);
          break;
        case "skip":
          if (player.queue.current === null) {
            throw new Error("현재 재생 중인 곡이 없습니다.");
          }
          if (isDjEnginePlayer(player)) {
            if (djPlayback === undefined || !djPlayback.isActive(player.guildId)) {
              throw new Error("DJ Engine 세션을 정리하고 있습니다.");
            }
            await djPlayback.skip(player.guildId, randomUUID());
          } else {
            await player.skip(0, false);
          }
          await refreshPlayerMessage(player);
          break;
        case "stop":
          if (djPlayback?.isActive(player.guildId) === true) {
            await djPlayback.stop(player.guildId, player);
          } else {
            await player.stopPlaying(true, false);
            await player.destroy("사용자가 플레이어 정지 버튼 실행");
          }
          await playerMessages.finish(player.guildId);
          break;
        case "autoplay": {
          if (isDjEnginePlayer(player)) {
            throw new Error("DJ Engine 자동 믹스에서는 자동재생을 사용할 수 없습니다.");
          }
          const state = states.getOrCreate(player.guildId);
          state.autoplayEnabled = !state.autoplayEnabled;
          if (state.autoplayEnabled) {
            autoplayFailures.delete(player.guildId);
          }
          await refreshPlayerMessage(player);
          break;
        }
        case "like":
        case "dislike": {
          if (isDjEnginePlayer(player)) {
            throw new Error("DJ Engine 자동 믹스에서는 추천 피드백을 사용할 수 없습니다.");
          }
          if (player.queue.current === null) {
            throw new Error("현재 재생 중인 곡이 없습니다.");
          }
          repository.setRecommendationFeedback(
            player.guildId,
            fromLavalinkTrack(player.queue.current),
            parsed.action
          );
          if (parsed.action === "dislike") {
            await player.skip(0, false);
          }
          await refreshPlayerMessage(player);
          break;
        }
        default:
          throw new Error("지원하지 않는 플레이어 버튼입니다.");
      }
    });

    const messages: Record<string, string> = {
      autoplay: "자동재생 상태를 변경했습니다.",
      dislike: "이 곡을 이후 추천에서 제외하고 다음 곡으로 넘어갑니다.",
      like: "이 곡을 서버의 추천 선호 시드로 저장했습니다.",
      skip: "현재 곡을 건너뛰었습니다.",
      stop: "재생을 종료하고 음성 채널에서 나왔습니다.",
      toggle: "재생 상태를 변경했습니다."
    };
    await interaction.editReply(messages[parsed.action] ?? "처리했습니다.");
  }

  async function requireControllablePlayer(
    interaction: ChatInputCommandInteraction
  ): Promise<Player | undefined> {
    const player = lavalink.getPlayer(interaction.guildId!);
    const voice = await getVoiceContext(interaction);
    if (!voice.ok) {
      await replyCommand(interaction, voice.message, true);
      return undefined;
    }
    if (player === undefined || player.queue.current === null) {
      await replyCommand(interaction, "현재 재생 중인 곡이 없습니다.", true);
      return undefined;
    }
    return player;
  }

  async function replyCommand(
    interaction: ChatInputCommandInteraction,
    content: string,
    ephemeral = false
  ): Promise<void> {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(content);
      return;
    }
    await interaction.reply(
      ephemeral ? { content, flags: MessageFlags.Ephemeral } : { content }
    );
  }

  async function getVoiceContext(
    interaction: ChatInputCommandInteraction | ButtonInteraction
  ) {
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

  async function getVoiceMembership(
    interaction: ChatInputCommandInteraction,
    playerChannelId: string | null
  ) {
    const member = await interaction.guild!.members.fetch(interaction.user.id);
    return validateVoiceMembership({
      memberChannelId: member.voice.channelId,
      playerChannelId
    });
  }

  function getSearchContext(guildId: string): {
    loader: LavalinkTrackLoader;
    node: LavalinkNode | NodeLinkNode;
  } {
    const node =
      lavalink.getPlayer(guildId)?.node ?? lavalink.nodeManager.getNode("local-lavalink");
    if (node === undefined || !node.connected) {
      throw new Error("Lavalink 오디오 서버가 아직 준비되지 않았습니다. 잠시 후 다시 시도해주세요.");
    }
    return { loader: new LavalinkTrackLoader(node), node };
  }

  function collectExcludedTrackIds(guildId: string): Set<string> {
    const excluded = new Set(states.getOrCreate(guildId).recentTrackIds);
    const player = lavalink.getPlayer(guildId);
    if (player?.queue.current !== null && player?.queue.current !== undefined) {
      excluded.add(player.queue.current.info.identifier);
    }
    for (const track of player?.queue.tracks ?? []) {
      if (!("resolve" in track)) {
        excluded.add(track.info.identifier);
      }
    }
    return excluded;
  }

  function createPlayerSnapshot(guildId: string): PlayerCardSnapshot | undefined {
    const player = lavalink.getPlayer(guildId);
    if (player === undefined) {
      return undefined;
    }
    const djTrack =
      djPlayback?.getDisplayTrack(guildId) ??
      (isDjEnginePlayer(player) ? createSafeDjTrack() : undefined);
    const current =
      djTrack ?? (player.queue.current === null ? null : fromLavalinkTrack(player.queue.current));
    const nextRaw = player.queue.tracks.find(
      (track) => !("resolve" in track) && !isDjEngineRawTrack(track)
    );
    const next =
      nextRaw === undefined || "resolve" in nextRaw ? null : fromLavalinkTrack(nextRaw);
    return {
      autoplayEnabled: djTrack === undefined && states.getOrCreate(guildId).autoplayEnabled,
      current,
      feedback:
        current === null || djTrack !== undefined
          ? null
          : (repository.getRecommendationFeedback(guildId, current.identifier) ?? null),
      next,
      positionMs: player.position,
      queueSize: player.queue.tracks.length,
      repeatMode: player.repeatMode,
      status:
        current === null
          ? "idle"
          : djPlayback?.isPaused(guildId) === true || player.paused
            ? "paused"
            : "playing",
      updatedAt: new Date(),
      volume: player.volume,
      voiceChannelId: player.voiceChannelId
    };
  }

  async function refreshPlayerMessage(player: Player, channelId?: string): Promise<void> {
    const targetChannelId = player.textChannelId ?? channelId;
    if (targetChannelId === null || targetChannelId === undefined) {
      return;
    }
    await playerMessages.refresh(player.guildId, targetChannelId).catch((error: unknown) => {
      console.error("플레이어 메시지를 갱신하지 못했습니다. Embed Links 권한을 확인해주세요.", error);
    });
  }

  function formatPlayerQueue(player: Player | undefined): string {
    if (player === undefined) {
      return "현재 재생 중인 곡이 없습니다.";
    }
    const djTrack =
      djPlayback?.getDisplayTrack(player.guildId) ??
      (isDjEnginePlayer(player) ? createSafeDjTrack() : undefined);
    const current =
      djTrack ?? (player.queue.current === null ? null : fromLavalinkTrack(player.queue.current));
    const upcoming = player.queue.tracks.flatMap((track) =>
      "resolve" in track || isDjEngineRawTrack(track) ? [] : [fromLavalinkTrack(track)]
    );
    return formatQueue(current, upcoming);
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
    await guildTasks.run(player.guildId, async () => {
      if (lavalink.getPlayer(player.guildId) !== player) {
        return;
      }
      await applyVoiceOccupancy(player, humanCount);
    });
  }

  async function applyVoiceOccupancy(player: Player, humanCount: number): Promise<void> {
    if (humanCount === 0) {
      if (djPlayback?.isActive(player.guildId) === true) {
        if (!djPlayback.isPaused(player.guildId)) {
          await djPlayback.pause(player.guildId, randomUUID());
          pausedForEmptyChannel.add(player.guildId);
        }
      } else if (player.playing) {
        await player.pause();
        pausedForEmptyChannel.add(player.guildId);
      }
      schedulePlayerDestroy(player);
      await refreshPlayerMessage(player);
      return;
    }

    idleTimers.cancel(player.guildId);
    if (pausedForEmptyChannel.delete(player.guildId)) {
      if (djPlayback?.isActive(player.guildId) === true) {
        await djPlayback.resume(player.guildId, randomUUID());
      } else if (player.paused) {
        await player.resume();
      }
    }
    await refreshPlayerMessage(player);
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

  async function cleanupDjPlayer(player: Player, reason: string): Promise<void> {
    await guildTasks.run(player.guildId, async () => {
      const current = lavalink.getPlayer(player.guildId);
      if (current !== undefined && current !== player) return;
      if (!isDjEnginePlayer(player)) return;
      try {
        await player.stopPlaying(true, false);
      } catch {
        // Player destroy와 엔진 DELETE는 계속 시도합니다.
      }
      await player.destroy(reason).catch(() => undefined);
      await djPlayback?.closeGuild(player.guildId, player).catch((error: unknown) => {
        console.error(`DJ Engine 세션 정리에 실패했습니다: guild=${player.guildId}`, error);
      });
      await playerMessages.finish(player.guildId);
    });
  }

  function cleanupDjPlayerInBackground(player: Player, reason: string): void {
    void cleanupDjPlayer(player, reason).catch((error: unknown) => {
      if (!stopping) {
        console.error(`DJ Engine 플레이어 자동 정리에 실패했습니다: guild=${player.guildId}`, error);
      }
    });
  }

  async function rejectUnsupportedDjControl(
    interaction: ChatInputCommandInteraction,
    player: Player,
    control: string
  ): Promise<boolean> {
    if (!isDjEnginePlayer(player)) return false;
    await interaction.reply({
      content: `DJ Engine 자동 믹스에서는 ${control} 기능을 사용할 수 없습니다.`,
      flags: MessageFlags.Ephemeral
    });
    return true;
  }

  function isDjEnginePlayer(player: Player): boolean {
    if (pendingDjStarts.get(player.guildId)?.player === player) return true;
    if (djPlayback?.ownsPlayer(player.guildId, player) === true) return true;
    if (isDjEngineRawTrack(player.queue.current)) return true;
    return player.queue.tracks.some((track) => isDjEngineRawTrack(track));
  }

  function isDjModeActive(guildId: string): boolean {
    return pendingDjStarts.has(guildId) || djPlayback?.isActive(guildId) === true;
  }

  return {
    client,
    lavalink,
    async start() {
      if (stopping) {
        throw new Error("종료가 시작된 봇은 다시 시작할 수 없습니다.");
      }
      healthHeartbeat.start();
      try {
        await client.login(config.DISCORD_TOKEN);
      } catch (error) {
        healthHeartbeat.stop();
        throw error;
      }
    },
    async stop() {
      if (stopPromise !== undefined) return stopPromise;
      stopping = true;
      stopPromise = (async () => {
        healthHeartbeat.stop();
        await guildRegistry?.stop();
        client.destroy();
        idleTimers.cancelAll();
        for (const timeout of genreDraftTimeouts.values()) clearTimeout(timeout);
        genreDraftTimeouts.clear();
        const pendingStops = pendingDjStarts.values().map(async (reservation) => {
          pendingDjStarts.cancel(reservation.guildId);
          await reservation.player
            ?.destroy("봇 종료 중인 DJ Engine 연결 취소")
            .catch(() => undefined);
        });
        const guildTaskDrain = guildTasks.close();

        const errors: unknown[] = [];
        await Promise.allSettled(pendingStops);
        await djPlayback?.closeAll().catch((error: unknown) => errors.push(error));
        await guildTaskDrain.catch((error: unknown) => errors.push(error));
        await mixPublisher?.stopAll().catch((error: unknown) => errors.push(error));
        const hasConnectedNode = [...lavalink.nodeManager.nodes.values()].some(
          (node) => node.connected
        );
        if (hasConnectedNode) {
          await lavalink.nodeManager
            .disconnectAll(true, true)
            .catch((error: unknown) => errors.push(error));
        }
        repository.close();
        if (errors.length > 0) {
          throw new AggregateError(errors, "봇 종료 중 일부 리소스를 정리하지 못했습니다.");
        }
      })();
      return stopPromise;
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

function manualQueueLength(player: Player): number {
  return player.queue.tracks.reduce((count, track) => {
    if ("resolve" in track) {
      return count + 1;
    }
    return count + (fromLavalinkTrack(track).origin === "recommended" ? 0 : 1);
  }, 0);
}

function isDjEngineRawTrack(track: unknown): boolean {
  if (typeof track !== "object" || track === null || !("userData" in track)) return false;
  const userData = track.userData;
  return (
    typeof userData === "object" &&
    userData !== null &&
    "djengine" in userData &&
    userData.djengine === 1
  );
}

function createSafeDjTrack(): MusicTrack {
  return {
    author: "DJ Engine",
    durationMs: 0,
    identifier: "djengine:closing",
    isSeekable: false,
    isStream: true,
    origin: "requested",
    sourceName: "djengine",
    title: "DJ Engine 자동 믹스",
    uri: "https://djengine.local/session"
  };
}

function isPlaybackRepeatMode(value: string): value is PlaybackRepeatMode {
  return value === "off" || value === "track" || value === "queue";
}

function genreCustomId(
  draft: GenreDraft<GenreDraftContext>,
  action: "cancel" | "confirm" | "next" | "previous" | "remove" | "select"
): string {
  return `genre:${draft.id}:${draft.revision}:${action}`;
}

function genreButton(
  draft: GenreDraft<GenreDraftContext>,
  action: "cancel" | "confirm" | "next" | "previous" | "remove",
  label: string,
  style: ButtonStyle,
  disabled: boolean
): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(genreCustomId(draft, action))
    .setLabel(label)
    .setStyle(style)
    .setDisabled(disabled);
}

function parseGenreCustomId(customId: string):
  | {
      action: string;
      draftId: string;
      revision: number;
    }
  | undefined {
  const [prefix, draftId, revisionValue, action, ...rest] = customId.split(":");
  const revision = Number(revisionValue);
  if (
    prefix !== "genre" ||
    draftId === undefined ||
    action === undefined ||
    rest.length > 0 ||
    !Number.isSafeInteger(revision)
  ) {
    return undefined;
  }
  return { action, draftId, revision };
}

function parsePlayerCustomId(customId: string):
  | {
      action: string;
      sessionId: string;
    }
  | undefined {
  const [prefix, sessionId, action, ...rest] = customId.split(":");
  if (prefix !== "music" || sessionId === undefined || action === undefined || rest.length > 0) {
    return undefined;
  }
  return { action, sessionId };
}

function genreDraftKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function escapeLinkText(value: string): string {
  return value.replaceAll("[", "(").replaceAll("]", ")");
}

function formatInlineCode(value: string): string {
  return `\`${value.trim().replaceAll("`", "'")}\``;
}

function escapeMarkdown(value: string): string {
  return value.replaceAll(/([\\*_~|`>])/gu, "\\$1");
}

function isDjEnergyProfile(value: string): value is DjEnergyProfile {
  return ["flat", "warmup", "build", "peak", "cooldown"].includes(value);
}

function formatDjEnergy(value: DjEnergyProfile): string {
  const labels: Record<DjEnergyProfile, string> = {
    build: "빌드업",
    cooldown: "쿨다운",
    flat: "일정하게",
    peak: "피크",
    warmup: "워밍업"
  };
  return labels[value];
}

function sanitizeDjStartError(error: unknown): Error {
  if (error instanceof Error && !/https?:\/\//u.test(error.message) && !/token=/iu.test(error.message)) {
    return error;
  }
  return new Error("DJ Engine 스트림을 준비하지 못했습니다. 잠시 후 다시 시도해주세요.");
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

async function respondToComponentError(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  error: unknown
): Promise<void> {
  const content = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
  if (interaction.customId.startsWith("genre:") && (interaction.deferred || interaction.replied)) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  } else if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content });
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

function resolveBefore<T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(undefined), timeoutMs);
    void operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      () => {
        clearTimeout(timeout);
        resolve(undefined);
      }
    );
  });
}
