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

const MIX_TRACK_SEED_LIMIT = 10;

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

    const mixTracks = result.tracks
      .filter((track) => !track.isStream && track.identifier !== seed.identifier)
      .filter((track, index, tracks) =>
        tracks.findIndex((candidate) => candidate.identifier === track.identifier) === index
      )
      .slice(0, MIX_TRACK_SEED_LIMIT);
    const expandedCandidates = await Promise.all(
      mixTracks.map(async (mixTrack) => {
        try {
          const mixTrackIdentifier = encodeURIComponent(mixTrack.identifier);
          const mixTrackUrl =
            `https://www.youtube.com/watch?v=${mixTrackIdentifier}&list=RD${mixTrackIdentifier}`;
          return (await this.#loader.load(mixTrackUrl, "autoplay", undefined)).tracks;
        } catch {
          return [];
        }
      })
    );
    const candidates = rankMixCandidates(expandedCandidates);

    return selectRecommendation({
      candidates: candidates.length === 0 ? result.tracks : candidates,
      currentIdentifier: seed.identifier,
      ...(excludedAuthors === undefined ? {} : { excludedAuthors }),
      ...(excludedTrackIds === undefined ? {} : { excludedIdentifiers: excludedTrackIds }),
      queuedIdentifiers: queuedTrackIds,
      recentIdentifiers: recentTrackIds
    });
  }
}

function rankMixCandidates(candidateGroups: readonly (readonly MusicTrack[])[]): MusicTrack[] {
  const occurrences = new Map<
    string,
    { firstPosition: number; track: MusicTrack; votes: number }
  >();

  candidateGroups.forEach((candidates, groupIndex) => {
    const identifiersInGroup = new Set<string>();
    candidates.forEach((candidate, candidateIndex) => {
      if (identifiersInGroup.has(candidate.identifier)) {
        return;
      }
      identifiersInGroup.add(candidate.identifier);
      const existing = occurrences.get(candidate.identifier);
      if (existing !== undefined) {
        existing.votes += 1;
        return;
      }
      occurrences.set(candidate.identifier, {
        firstPosition: groupIndex * MIX_TRACK_SEED_LIMIT + candidateIndex,
        track: candidate,
        votes: 1
      });
    });
  });

  return [...occurrences.values()]
    .sort((left, right) => right.votes - left.votes || left.firstPosition - right.firstPosition)
    .map(({ track }) => track);
}
