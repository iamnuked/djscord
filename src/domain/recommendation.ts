import type { MusicTrack } from "./types.js";

interface RecommendationSelection {
  candidates: readonly MusicTrack[];
  currentIdentifier: string;
  excludedAuthors?: ReadonlySet<string>;
  excludedIdentifiers?: ReadonlySet<string>;
  queuedIdentifiers: ReadonlySet<string>;
  recentIdentifiers: ReadonlySet<string>;
}

export function selectRecommendation({
  candidates,
  currentIdentifier,
  excludedAuthors = new Set(),
  excludedIdentifiers = new Set(),
  queuedIdentifiers,
  recentIdentifiers
}: RecommendationSelection): MusicTrack | undefined {
  const selected = candidates.find(
    (candidate) =>
      !candidate.isStream &&
      candidate.identifier !== currentIdentifier &&
      !excludedIdentifiers.has(candidate.identifier) &&
      !excludedAuthors.has(normalizeRecommendationAuthor(candidate.author)) &&
      !queuedIdentifiers.has(candidate.identifier) &&
      !recentIdentifiers.has(candidate.identifier)
  );

  if (selected === undefined) {
    return undefined;
  }

  const trackWithoutRequester = { ...selected };
  delete trackWithoutRequester.requesterId;
  return {
    ...trackWithoutRequester,
    origin: "recommended"
  };
}

export function normalizeRecommendationAuthor(author: string): string {
  return author.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}
