export class GuildTaskQueue {
  #accepting = true;
  readonly #tails = new Map<string, Promise<void>>();

  run<T>(guildId: string, task: () => Promise<T> | T): Promise<T> {
    if (!this.#accepting) {
      return Promise.reject(new Error("길드 작업 큐가 종료 중입니다."));
    }
    const previous = this.#tails.get(guildId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const tail = result.then(
      () => undefined,
      () => undefined
    );

    this.#tails.set(guildId, tail);
    void tail.then(() => {
      if (this.#tails.get(guildId) === tail) {
        this.#tails.delete(guildId);
      }
    });

    return result;
  }

  async close(): Promise<void> {
    this.#accepting = false;
    await Promise.allSettled([...this.#tails.values()]);
  }
}
