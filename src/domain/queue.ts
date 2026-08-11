import type { MusicTrack } from "./types.js";

interface QueueLimits {
  perRequestLimit: number;
  queueLimit: number;
}

interface QueueAddResult {
  added: number;
  queue: MusicTrack[];
  skipped: number;
}

export function addRequestedTracks(
  existing: readonly MusicTrack[],
  incoming: readonly MusicTrack[],
  limits: QueueLimits
): QueueAddResult {
  const availableSlots = Math.max(0, limits.queueLimit - existing.length);
  const acceptedCount = Math.min(incoming.length, limits.perRequestLimit, availableSlots);
  const accepted = incoming.slice(0, acceptedCount);

  return {
    added: accepted.length,
    queue: [...existing, ...accepted],
    skipped: incoming.length - accepted.length
  };
}

