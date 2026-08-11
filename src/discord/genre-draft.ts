import type { MusicTrack } from "../domain/types.js";

const PAGE_SIZE = 10;

export interface GenreDraft<TContext> {
  context: TContext;
  expiresAt: number;
  guildId: string;
  id: string;
  page: number;
  revision: number;
  selectedTrackIds: Set<string>;
  tracks: MusicTrack[];
  userId: string;
}

export interface GenreDraftStoreOptions {
  idFactory: () => string;
  ttlMs: number;
}

export class GenreDraftStore<TContext> {
  readonly #drafts = new Map<string, GenreDraft<TContext>>();
  readonly #idFactory: () => string;
  readonly #ttlMs: number;

  constructor(options: GenreDraftStoreOptions) {
    this.#idFactory = options.idFactory;
    this.#ttlMs = options.ttlMs;
  }

  create(input: {
    context: TContext;
    guildId: string;
    now: number;
    tracks: MusicTrack[];
    userId: string;
  }): { draft: GenreDraft<TContext>; replaced?: GenreDraft<TContext> } {
    const key = draftKey(input.guildId, input.userId);
    const replaced = this.#drafts.get(key);
    const draft: GenreDraft<TContext> = {
      context: input.context,
      expiresAt: input.now + this.#ttlMs,
      guildId: input.guildId,
      id: this.#idFactory(),
      page: 0,
      revision: 0,
      selectedTrackIds: new Set(),
      tracks: [...input.tracks],
      userId: input.userId
    };
    this.#drafts.set(key, draft);
    return replaced === undefined ? { draft } : { draft, replaced };
  }

  find(
    guildId: string,
    userId: string,
    id: string,
    revision: number,
    now: number
  ): GenreDraft<TContext> | undefined {
    const key = draftKey(guildId, userId);
    const draft = this.#drafts.get(key);
    if (draft === undefined) {
      return undefined;
    }
    if (now >= draft.expiresAt) {
      this.#drafts.delete(key);
      return undefined;
    }
    return draft.id === id && draft.revision === revision ? draft : undefined;
  }

  getCurrent(guildId: string, userId: string, now: number): GenreDraft<TContext> | undefined {
    const key = draftKey(guildId, userId);
    const draft = this.#drafts.get(key);
    if (draft !== undefined && now >= draft.expiresAt) {
      this.#drafts.delete(key);
      return undefined;
    }
    return draft;
  }

  setSelection(
    draft: GenreDraft<TContext>,
    identifiers: readonly string[],
    now: number
  ): GenreDraft<TContext> {
    const current = this.#requireCurrent(draft, now);
    const pageIds = new Set(
      current.tracks
        .slice(current.page * PAGE_SIZE, (current.page + 1) * PAGE_SIZE)
        .map(({ identifier }) => identifier)
    );
    const selectedTrackIds = new Set(current.selectedTrackIds);
    for (const id of pageIds) {
      selectedTrackIds.delete(id);
    }
    for (const id of identifiers) {
      if (pageIds.has(id)) {
        selectedTrackIds.add(id);
      }
    }
    return this.#replace(current, { selectedTrackIds });
  }

  setPage(draft: GenreDraft<TContext>, page: number, now: number): GenreDraft<TContext> {
    const current = this.#requireCurrent(draft, now);
    return this.#replace(current, { page: clampPage(page, current.tracks.length) });
  }

  removeSelected(draft: GenreDraft<TContext>, now: number): GenreDraft<TContext> {
    const current = this.#requireCurrent(draft, now);
    const tracks = current.tracks.filter(
      ({ identifier }) => !current.selectedTrackIds.has(identifier)
    );
    return this.#replace(current, {
      page: clampPage(current.page, tracks.length),
      selectedTrackIds: new Set(),
      tracks
    });
  }

  consume(draft: GenreDraft<TContext>, now: number): GenreDraft<TContext> | undefined {
    const current = this.find(
      draft.guildId,
      draft.userId,
      draft.id,
      draft.revision,
      now
    );
    if (current === undefined || current !== draft) {
      return undefined;
    }
    this.#drafts.delete(draftKey(current.guildId, current.userId));
    return current;
  }

  cancel(draft: GenreDraft<TContext>): void {
    const key = draftKey(draft.guildId, draft.userId);
    const current = this.#drafts.get(key);
    if (current === draft) {
      this.#drafts.delete(key);
    }
  }

  #requireCurrent(draft: GenreDraft<TContext>, now: number): GenreDraft<TContext> {
    const current = this.find(
      draft.guildId,
      draft.userId,
      draft.id,
      draft.revision,
      now
    );
    if (current === undefined || current !== draft) {
      throw new Error("만료되었거나 이미 변경된 장르 미리보기입니다.");
    }
    return current;
  }

  #replace(
    current: GenreDraft<TContext>,
    changes: Partial<Pick<GenreDraft<TContext>, "page" | "selectedTrackIds" | "tracks">>
  ): GenreDraft<TContext> {
    const updated: GenreDraft<TContext> = {
      ...current,
      ...changes,
      revision: current.revision + 1
    };
    this.#drafts.set(draftKey(updated.guildId, updated.userId), updated);
    return updated;
  }
}

function clampPage(page: number, trackCount: number): number {
  const lastPage = Math.max(0, Math.ceil(trackCount / PAGE_SIZE) - 1);
  return Math.min(Math.max(0, page), lastPage);
}

function draftKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}
