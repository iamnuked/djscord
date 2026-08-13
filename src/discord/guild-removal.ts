export interface RemovedGuildPlayer {
  destroy(reason: string): Promise<unknown>;
}

interface CleanupRemovedGuildOptions<TPlayer extends RemovedGuildPlayer> {
  activePlayer?: TPlayer;
  closePlayback(player: TPlayer | undefined): Promise<void>;
  finishPlayerMessage(): Promise<void>;
  pendingPlayer?: TPlayer;
}

/**
 * Releases every resource that can outlive a Discord guild removal event.
 * The primary player is delegated to the DJ playback service so its engine
 * session and mix publisher are stopped before any duplicate player is torn down.
 */
export async function cleanupRemovedGuild<TPlayer extends RemovedGuildPlayer>(
  options: CleanupRemovedGuildOptions<TPlayer>
): Promise<void> {
  const primaryPlayer = options.activePlayer ?? options.pendingPlayer;
  const failures: unknown[] = [];

  await options.closePlayback(primaryPlayer).catch((error: unknown) => {
    failures.push(error);
  });

  if (
    options.pendingPlayer !== undefined &&
    options.pendingPlayer !== primaryPlayer
  ) {
    await options.pendingPlayer
      .destroy("Discord 서버에서 봇이 제거됨")
      .catch((error: unknown) => failures.push(error));
  }

  await options.finishPlayerMessage().catch((error: unknown) => {
    failures.push(error);
  });

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "제거된 Discord 서버의 재생 리소스 정리에 실패했습니다.");
  }
}
