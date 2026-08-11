import { randomUUID } from "node:crypto";

import {
  ActionRowBuilder,
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
import {
  fromLavalinkTrack,
  LavalinkTrackLoader
} from "../infrastructure/lavalink-track-loader.js";
import { AutoplayService } from "../music/autoplay-service.js";
import { GenrePlaylistService } from "../music/genre-playlist.js";
import { GuildTaskQueue } from "../music/guild-task-queue.js";
import { IdleTimerManager } from "../music/idle-timer.js";
import { TrackResolverService } from "../music/track-resolver.js";
import { GenreDraftStore, type GenreDraft } from "./genre-draft.js";
import {
  PlayerMessageController,
  type PlayerMessagePayload
} from "./player-message-controller.js";
import type { PlayerCardSnapshot } from "./player-view.js";
import { formatQueue } from "./queue-view.js";
import { validateVoiceAccess } from "./voice-access.js";

const IDLE_TIMEOUT_MS = 300_000;
const MANUAL_QUEUE_LIMIT = 100;
const SEARCH_SELECTION_TIMEOUT_MS = 30_000;
const GENRE_DRAFT_TIMEOUT_MS = 600_000;
const GENRE_PAGE_SIZE = 10;

interface GenreDraftContext {
  interaction: ChatInputCommandInteraction;
  loader: LavalinkTrackLoader;
  missingCount: number;
  node: LavalinkNode | NodeLinkNode;
  nodeId: string;
}

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
  const guildTasks = new GuildTaskQueue();
  const genreDrafts = new GenreDraftStore<GenreDraftContext>({
    idFactory: randomUUID,
    ttlMs: GENRE_DRAFT_TIMEOUT_MS
  });
  const genreDraftTimeouts = new Map<string, NodeJS.Timeout>();

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
    snapshotProvider: (guildId) => createPlayerSnapshot(guildId)
  });

  async function enqueueRecommendation(player: Player, lastPlayedTrack: Track): Promise<void> {
    const state = states.getOrCreate(player.guildId);
    if (!state.autoplayEnabled || manualQueueLength(player) > 0) {
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

      await guildTasks.run(player.guildId, async () => {
        const latestState = states.getOrCreate(player.guildId);
        if (
          lavalink.getPlayer(player.guildId) !== player ||
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
    states.rememberTrack(player.guildId, track.info.identifier);
    void refreshPlayerMessage(player);
  });

  lavalink.on("trackEnd", (player) => {
    void refreshPlayerMessage(player);
  });

  lavalink.on("trackError", (player, track, payload) => {
    console.error(`트랙 재생 오류: ${track?.info.title ?? "알 수 없는 곡"}`, payload);
    void sendToPlayerChannel(player, "현재 곡을 재생하지 못해 다음 곡으로 넘어갑니다.");
    void refreshPlayerMessage(player);
  });

  lavalink.on("trackStuck", (player, track) => {
    console.error(`트랙 멈춤: ${track?.info.title ?? "알 수 없는 곡"}`);
    void sendToPlayerChannel(player, "현재 곡의 재생이 멈춰 다음 곡으로 넘어갑니다.");
    void refreshPlayerMessage(player);
  });

  lavalink.on("queueEnd", (player) => {
    schedulePlayerDestroy(player);
    void refreshPlayerMessage(player);
  });

  lavalink.on("playerDestroy", (player) => {
    idleTimers.cancel(player.guildId);
    pausedForEmptyChannel.delete(player.guildId);
    autoplayFailures.delete(player.guildId);
    states.delete(player.guildId);
    void playerMessages.finish(player.guildId).catch((error: unknown) => {
      console.error("종료된 플레이어 메시지를 갱신하지 못했습니다.", error);
    });
  });

  client.on("raw", (payload) => {
    lavalink.sendRawData(payload);
  });

  client.on("voiceStateUpdate", (oldState, newState) => {
    void handleVoiceStateUpdate(oldState, newState);
  });

  client.on("interactionCreate", (interaction) => {
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
      case "장르":
        await handleGenre(interaction);
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
          volume: 100
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
    const service = new GenrePlaylistService(searchContext.loader);
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
        nodeId: searchContext.node.options.id ?? "local-lavalink"
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
          volume: 100
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
        { name: "제거 선택", value: `${draft.selectedTrackIds.size}곡`, inline: true }
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
    const player = await requireControllablePlayer(interaction);
    if (player === undefined) return;
    if (player.paused) {
      await interaction.reply({ content: "이미 일시정지 상태입니다.", flags: MessageFlags.Ephemeral });
      return;
    }
    await guildTasks.run(player.guildId, async () => {
      await player.pause();
      await refreshPlayerMessage(player);
    });
    await interaction.reply("재생을 일시정지했습니다.");
  }

  async function handleResume(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = await requireControllablePlayer(interaction);
    if (player === undefined) return;
    if (!player.paused) {
      await interaction.reply({ content: "일시정지된 곡이 없습니다.", flags: MessageFlags.Ephemeral });
      return;
    }
    await guildTasks.run(player.guildId, async () => {
      pausedForEmptyChannel.delete(player.guildId);
      idleTimers.cancel(player.guildId);
      await player.resume();
      await refreshPlayerMessage(player);
    });
    await interaction.reply("재생을 계속합니다.");
  }

  async function handleSkip(interaction: ChatInputCommandInteraction): Promise<void> {
    const player = await requireControllablePlayer(interaction);
    if (player === undefined) return;
    await guildTasks.run(player.guildId, async () => {
      await player.skip(0, false);
      await refreshPlayerMessage(player);
    });
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
    const guildId = interaction.guildId!;
    const enabled = interaction.options.getString("모드", true) === "on";
    await guildTasks.run(guildId, async () => {
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
    const voice = await getVoiceContext(interaction);
    if (!voice.ok) {
      await interaction.reply({ content: voice.message, flags: MessageFlags.Ephemeral });
      return;
    }
    const player = lavalink.getPlayer(interaction.guildId!);
    if (player === undefined) {
      await interaction.reply({
        content: "현재 재생 세션이 없습니다.",
        flags: MessageFlags.Ephemeral
      });
      return;
    }
    await guildTasks.run(player.guildId, async () => {
      await player.stopPlaying(true, false);
      await player.destroy("사용자가 정지 명령 실행");
      await playerMessages.finish(player.guildId);
    });
    await interaction.reply("재생을 종료하고 음성 채널에서 나왔습니다.");
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
          if (player.paused) {
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
          await player.skip(0, false);
          await refreshPlayerMessage(player);
          break;
        case "stop":
          await player.stopPlaying(true, false);
          await player.destroy("사용자가 플레이어 정지 버튼 실행");
          await playerMessages.finish(player.guildId);
          break;
        case "autoplay": {
          const state = states.getOrCreate(player.guildId);
          state.autoplayEnabled = !state.autoplayEnabled;
          if (state.autoplayEnabled) {
            autoplayFailures.delete(player.guildId);
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
    const current =
      player.queue.current === null ? null : fromLavalinkTrack(player.queue.current);
    const nextRaw = player.queue.tracks.find((track) => !("resolve" in track));
    const next =
      nextRaw === undefined || "resolve" in nextRaw ? null : fromLavalinkTrack(nextRaw);
    return {
      autoplayEnabled: states.getOrCreate(guildId).autoplayEnabled,
      current,
      next,
      positionMs: player.position,
      queueSize: player.queue.tracks.length,
      status: current === null ? "idle" : player.paused ? "paused" : "playing",
      updatedAt: new Date()
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
    const current =
      player.queue.current === null ? null : fromLavalinkTrack(player.queue.current);
    const upcoming = player.queue.tracks.flatMap((track) =>
      "resolve" in track ? [] : [fromLavalinkTrack(track)]
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
      if (humanCount === 0) {
        if (player.playing) {
          await player.pause();
          pausedForEmptyChannel.add(player.guildId);
        }
        schedulePlayerDestroy(player);
        await refreshPlayerMessage(player);
        return;
      }

      idleTimers.cancel(player.guildId);
      if (pausedForEmptyChannel.delete(player.guildId) && player.paused) {
        await player.resume();
      }
      await refreshPlayerMessage(player);
    });
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

function manualQueueLength(player: Player): number {
  return player.queue.tracks.reduce((count, track) => {
    if ("resolve" in track) {
      return count + 1;
    }
    return count + (fromLavalinkTrack(track).origin === "recommended" ? 0 : 1);
  }, 0);
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
