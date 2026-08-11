import type { MusicTrack } from "./types.js";

interface RecommendationSelection {
  candidates: readonly MusicTrack[];
  currentIdentifier: string;
  queuedIdentifiers: ReadonlySet<string>;
  recentIdentifiers: ReadonlySet<string>;
}

export function selectRecommendation({
  candidates,
  currentIdentifier,
  queuedIdentifiers,
  recentIdentifiers
}: RecommendationSelection): MusicTrack | undefined {
  const selected = candidates.find(
    (candidate) =>
      !candidate.isStream &&
      candidate.identifier !== currentIdentifier &&
      !queuedIdentifiers.has(candidate.identifier) &&
      !recentIdentifiers.has(candidate.identifier)
  );

  if (selected === undefined) {
    return undefined;
  }

  const { requesterId: _requesterId, ...trackWithoutRequester } = selected;
  return {
    ...trackWithoutRequester,
    origin: "recommended"
  };
}

