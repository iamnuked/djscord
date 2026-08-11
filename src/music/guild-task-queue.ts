export class GuildTaskQueue {
  readonly #tails = new Map<string, Promise<void>>();

  run<T>(guildId: string, task: () => Promise<T> | T): Promise<T> {
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
}
