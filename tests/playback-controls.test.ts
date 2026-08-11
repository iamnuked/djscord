import { describe, expect, it, vi } from "vitest";

import {
  moveQueuedTrack,
  parseSeekPosition,
  removeQueuedTrack,
  validateSeekPosition
} from "../src/music/playback-controls.js";

class FakeQueue<T> {
  readonly tracks: T[];
  readonly save = vi.fn(async () => undefined);

  constructor(tracks: T[]) {
    this.tracks = tracks;
  }

  async splice(index: number, amount: number, additions?: T | T[]): Promise<T | T[] | null> {
    const inserted = additions === undefined ? [] : Array.isArray(additions) ? additions : [additions];
    const removed = this.tracks.splice(index, amount, ...inserted);
    await this.save();
    if (removed.length === 0) return null;
    return removed.length === 1 ? removed[0]! : removed;
  }
}

describe("parseSeekPosition", () => {
  it.each([
    ["90", 90_000],
    ["1:30", 90_000],
    ["1:02:03", 3_723_000]
  ])("%s를 밀리초로 변환한다", (input, expected) => {
    expect(parseSeekPosition(input)).toBe(expected);
  });

  it.each(["", "abc", "1:60", "1:2:60", "-1", "1:2:3:4"])(
    "잘못된 시간 %s를 거부한다",
    (input) => {
      expect(() => parseSeekPosition(input)).toThrow("시간은");
    }
  );
});

describe("validateSeekPosition", () => {
  it("곡 길이 안의 탐색 위치를 반환한다", () => {
    expect(
      validateSeekPosition({ durationMs: 180_000, isSeekable: true, isStream: false }, 90_000)
    ).toBe(90_000);
  });

  it("라이브·탐색 불가 곡과 곡 길이 밖의 위치를 거부한다", () => {
    expect(() =>
      validateSeekPosition({ durationMs: 0, isSeekable: false, isStream: true }, 1_000)
    ).toThrow("탐색할 수 없는");
    expect(() =>
      validateSeekPosition({ durationMs: 180_000, isSeekable: true, isStream: false }, 180_001)
    ).toThrow("곡 길이");
  });
});

describe("대기열 편집", () => {
  it("사용자에게 보이는 1부터 시작하는 번호로 곡을 삭제한다", async () => {
    const queue = new FakeQueue(["a", "b", "c"]);

    await expect(removeQueuedTrack(queue, 2)).resolves.toBe("b");
    expect(queue.tracks).toEqual(["a", "c"]);
  });

  it("곡을 최종 목적지 번호로 이동하고 순서를 보존한다", async () => {
    const queue = new FakeQueue(["a", "b", "c", "d"]);

    await expect(moveQueuedTrack(queue, 1, 3)).resolves.toBe("a");
    expect(queue.tracks).toEqual(["b", "c", "a", "d"]);
  });

  it("범위를 벗어난 번호와 같은 위치 이동을 거부한다", async () => {
    const queue = new FakeQueue(["a", "b"]);

    await expect(removeQueuedTrack(queue, 3)).rejects.toThrow("대기열 번호");
    await expect(moveQueuedTrack(queue, 1, 1)).rejects.toThrow("같습니다");
  });
});
