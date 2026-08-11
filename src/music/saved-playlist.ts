import type { MusicTrack } from "../domain/types.js";
import type { TrackLoader } from "./ports.js";

export interface RestoredTracks {
  tracks: MusicTrack[];
  unavailableCount: number;
}

export async function restoreSavedTracks(
  loader: TrackLoader,
  savedTracks: readonly MusicTrack[],
  requesterId: string
): Promise<RestoredTracks> {
  const tracks: MusicTrack[] = [];
  let unavailableCount = 0;

  for (const savedTrack of savedTracks) {
    try {
      const loaded = await loader.load(savedTrack.uri, requesterId);
      const resolved =
        loaded.tracks.find(({ identifier }) => identifier === savedTrack.identifier) ??
        loaded.tracks[0];
      if (resolved === undefined) {
        unavailableCount += 1;
        continue;
      }
      tracks.push({ ...resolved, origin: "requested", requesterId });
    } catch {
      unavailableCount += 1;
    }
  }

  return { tracks, unavailableCount };
}
