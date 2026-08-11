import type { MusicTrack } from "../domain/types.js";
import { selectRecommendation } from "../domain/recommendation.js";
import type { TrackLoader } from "./ports.js";

interface RecommendationRequest {
  enabled: boolean;
  excludedAuthors?: ReadonlySet<string>;
  excludedTrackIds?: ReadonlySet<string>;
  lastTrack: MusicTrack;
  preferredSeed?: MusicTrack;
  queuedTrackIds: ReadonlySet<string>;
  recentTrackIds: ReadonlySet<string>;
}

export class AutoplayService {
  readonly #loader: TrackLoader;

  constructor(loader: TrackLoader) {
    this.#loader = loader;
  }

  async recommend({
    enabled,
    excludedAuthors,
    excludedTrackIds,
    lastTrack,
    preferredSeed,
    queuedTrackIds,
    recentTrackIds
  }: RecommendationRequest): Promise<MusicTrack | undefined> {
    if (!enabled) {
      return undefined;
    }

    const seed = preferredSeed ?? lastTrack;
    const identifier = encodeURIComponent(seed.identifier);
    const mixUrl = `https://www.youtube.com/watch?v=${identifier}&list=RD${identifier}`;
    const result = await this.#loader.load(mixUrl, "autoplay", undefined);

    return selectRecommendation({
      candidates: result.tracks,
      currentIdentifier: seed.identifier,
      ...(excludedAuthors === undefined ? {} : { excludedAuthors }),
      ...(excludedTrackIds === undefined ? {} : { excludedIdentifiers: excludedTrackIds }),
      queuedIdentifiers: queuedTrackIds,
      recentIdentifiers: recentTrackIds
    });
  }
}
