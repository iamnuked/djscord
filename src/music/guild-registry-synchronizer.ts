interface GuildRegistrySynchronizerOptions {
  intervalMs: number;
  onError(error: unknown): void;
  sync(): Promise<void>;
}

/** Serializes Discord guild registry uploads and retries them on a fixed interval. */
export class GuildRegistrySynchronizer {
  readonly #intervalMs: number;
  readonly #onError: (error: unknown) => void;
  readonly #sync: () => Promise<void>;
  #stopped = false;
  #tail = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;

  constructor(options: GuildRegistrySynchronizerOptions) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error("Discord 서버 동기화 주기는 양의 정수여야 합니다.");
    }
    this.#intervalMs = options.intervalMs;
    this.#onError = options.onError;
    this.#sync = options.sync;
  }

  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#timer = setInterval(() => void this.trigger(), this.#intervalMs);
    this.#timer.unref();
  }

  trigger(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    const operation = this.#tail.then(async () => {
      if (!this.#stopped) await this.#sync();
    });
    this.#tail = operation.catch((error: unknown) => {
      this.#onError(error);
    });
    return this.#tail;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await this.#tail;
  }
}
