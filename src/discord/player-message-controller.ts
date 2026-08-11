import {
  buildPlayerCard,
  type PlayerCardOptions,
  type PlayerCardPayload,
  type PlayerCardSnapshot
} from "./player-view.js";

export type PlayerMessagePayload = PlayerCardPayload;

export interface EditablePlayerMessage {
  edit(payload: PlayerMessagePayload): Promise<void>;
  id: string;
}

interface PlayerMessageControllerOptions {
  idFactory: () => string;
  send: (channelId: string, payload: PlayerMessagePayload) => Promise<EditablePlayerMessage>;
  snapshotProvider: (guildId: string) => PlayerCardSnapshot | undefined;
  supportUrl?: string;
}

interface PlayerMessageState {
  channelId: string;
  lastSnapshot: PlayerCardSnapshot;
  message: EditablePlayerMessage;
  sessionId: string;
}

export class PlayerMessageController {
  readonly #cooldowns = new Map<string, number>();
  readonly #idFactory: () => string;
  readonly #playerCardOptions: PlayerCardOptions;
  readonly #send: PlayerMessageControllerOptions["send"];
  readonly #snapshotProvider: PlayerMessageControllerOptions["snapshotProvider"];
  readonly #states = new Map<string, PlayerMessageState>();
  readonly #tails = new Map<string, Promise<void>>();

  constructor(options: PlayerMessageControllerOptions) {
    this.#idFactory = options.idFactory;
    this.#playerCardOptions =
      options.supportUrl === undefined ? {} : { supportUrl: options.supportUrl };
    this.#send = options.send;
    this.#snapshotProvider = options.snapshotProvider;
  }

  refresh(guildId: string, channelId: string): Promise<void> {
    return this.#enqueue(guildId, async () => {
      const snapshot = this.#snapshotProvider(guildId);
      if (snapshot === undefined) {
        return;
      }

      const existing = this.#states.get(guildId);
      if (existing === undefined) {
        const sessionId = this.#idFactory();
        const message = await this.#send(
          channelId,
          buildPlayerCard(snapshot, sessionId, this.#playerCardOptions)
        );
        this.#states.set(guildId, {
          channelId,
          lastSnapshot: snapshot,
          message,
          sessionId
        });
        return;
      }

      const payload = buildPlayerCard(snapshot, existing.sessionId, this.#playerCardOptions);
      try {
        await existing.message.edit(payload);
        existing.lastSnapshot = snapshot;
      } catch {
        existing.message = await this.#send(existing.channelId, payload);
        existing.lastSnapshot = snapshot;
      }
    });
  }

  finish(guildId: string): Promise<void> {
    return this.#enqueue(guildId, async () => {
      const state = this.#states.get(guildId);
      if (state === undefined) {
        return;
      }
      const ended: PlayerCardSnapshot = {
        ...state.lastSnapshot,
        current: null,
        next: null,
        positionMs: 0,
        queueSize: 0,
        status: "ended",
        updatedAt: new Date()
      };
      const payload = buildPlayerCard(ended, state.sessionId, this.#playerCardOptions);
      try {
        await state.message.edit(payload);
      } catch {
        await this.#send(state.channelId, payload).catch(() => undefined);
      } finally {
        this.#states.delete(guildId);
        this.#cooldowns.delete(guildId);
      }
    });
  }

  isCurrent(guildId: string, sessionId: string, messageId: string): boolean {
    const state = this.#states.get(guildId);
    return state?.sessionId === sessionId && state.message.id === messageId;
  }

  tryRefresh(guildId: string, now: number): boolean {
    const last = this.#cooldowns.get(guildId);
    if (last !== undefined && now - last < 5_000) {
      return false;
    }
    this.#cooldowns.set(guildId, now);
    return true;
  }

  #enqueue(guildId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.#tails.get(guildId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const tail = result.catch(() => undefined);
    this.#tails.set(guildId, tail);
    void tail.then(() => {
      if (this.#tails.get(guildId) === tail) {
        this.#tails.delete(guildId);
      }
    });
    return result;
  }
}
