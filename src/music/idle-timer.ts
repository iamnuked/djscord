type ExpireHandler = () => Promise<void> | void;

export class IdleTimerManager {
  readonly #delayMs: number;
  readonly #timers = new Map<string, NodeJS.Timeout>();

  constructor(delayMs: number) {
    this.#delayMs = delayMs;
  }

  schedule(guildId: string, onExpire: ExpireHandler): void {
    this.cancel(guildId);
    const timer = setTimeout(() => {
      this.#timers.delete(guildId);
      void onExpire();
    }, this.#delayMs);
    timer.unref();
    this.#timers.set(guildId, timer);
  }

  cancel(guildId: string): void {
    const timer = this.#timers.get(guildId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(guildId);
    }
  }
}

