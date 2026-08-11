export type PlaybackRepeatMode = "off" | "queue" | "track";

export interface MutablePlaybackQueue<T> {
  readonly tracks: readonly T[];
  splice(index: number, amount: number, additions?: T | T[]): Promise<T | T[] | null>;
}

interface SeekableTrack {
  durationMs: number;
  isSeekable: boolean;
  isStream: boolean;
}

export function parseSeekPosition(value: string): number {
  const parts = value.trim().split(":");
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
    throw invalidTimeError();
  }

  const numbers = parts.map(Number);
  if (numbers.some((part) => !Number.isSafeInteger(part))) {
    throw invalidTimeError();
  }

  let seconds: number;
  if (numbers.length === 1) {
    seconds = numbers[0]!;
  } else if (numbers.length === 2) {
    const [minutes, remainingSeconds] = numbers;
    if (remainingSeconds! >= 60) throw invalidTimeError();
    seconds = minutes! * 60 + remainingSeconds!;
  } else {
    const [hours, minutes, remainingSeconds] = numbers;
    if (minutes! >= 60 || remainingSeconds! >= 60) throw invalidTimeError();
    seconds = hours! * 3_600 + minutes! * 60 + remainingSeconds!;
  }

  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw invalidTimeError();
  }
  return milliseconds;
}

export function validateSeekPosition(track: SeekableTrack, positionMs: number): number {
  if (!track.isSeekable || track.isStream) {
    throw new Error("라이브 스트림 또는 탐색할 수 없는 곡입니다.");
  }
  if (positionMs < 0 || positionMs > track.durationMs) {
    throw new Error("탐색 위치가 곡 길이를 벗어났습니다.");
  }
  return positionMs;
}

export async function removeQueuedTrack<T>(
  queue: MutablePlaybackQueue<T>,
  position: number
): Promise<T> {
  const index = toQueueIndex(position, queue.tracks.length);
  const track = queue.tracks[index]!;
  await queue.splice(index, 1);
  return track;
}

export async function moveQueuedTrack<T>(
  queue: MutablePlaybackQueue<T>,
  fromPosition: number,
  toPosition: number
): Promise<T> {
  const fromIndex = toQueueIndex(fromPosition, queue.tracks.length);
  const toIndex = toQueueIndex(toPosition, queue.tracks.length);
  if (fromIndex === toIndex) {
    throw new Error("현재 위치와 이동할 위치가 같습니다.");
  }

  const track = queue.tracks[fromIndex]!;
  await queue.splice(fromIndex, 1);
  await queue.splice(toIndex, 0, track);
  return track;
}

export function formatRepeatMode(mode: PlaybackRepeatMode): string {
  return mode === "track" ? "한 곡" : mode === "queue" ? "전체" : "끔";
}

function toQueueIndex(position: number, length: number): number {
  if (!Number.isSafeInteger(position) || position < 1 || position > length) {
    throw new Error(`대기열 번호는 1부터 ${length} 사이여야 합니다.`);
  }
  return position - 1;
}

function invalidTimeError(): Error {
  return new Error("시간은 `90`, `1:30` 또는 `1:02:03` 형식으로 입력해주세요.");
}
