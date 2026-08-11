import { describe, expect, it } from "vitest";

import {
  GENRE_SEED_PROFILES,
  resolveLastFmGenreTag,
  resolveGenreSeedProfile
} from "../src/music/genre-seeds.js";

describe("genre seed profiles", () => {
  it.each(["k-pop", "KPOP", "k pop", "케이팝"])(
    "%s를 동일한 K-pop 시드 프로필로 정규화한다",
    (genre) => {
      expect(resolveGenreSeedProfile(genre)?.id).toBe("k-pop");
    }
  );

  it("K-pop에 서로 다른 대표 아티스트 시드를 관리한다", () => {
    const profile = resolveGenreSeedProfile("k-pop");

    expect(profile?.seeds.map(({ artist }) => artist)).toEqual([
      "BTS",
      "BLACKPINK",
      "aespa",
      "IVE",
      "Stray Kids",
      "NewJeans"
    ]);
  });

  it("등록되지 않은 자유 입력 장르는 시드 프로필을 강제하지 않는다", () => {
    expect(resolveGenreSeedProfile("city pop night drive")).toBeUndefined();
  });

  it("프로필 ID와 별칭이 서로 충돌하지 않는다", () => {
    const aliases = GENRE_SEED_PROFILES.flatMap((profile) => [profile.id, ...profile.aliases]);
    const normalized = aliases.map((alias) =>
      alias.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[\s_-]+/g, "")
    );

    expect(new Set(normalized).size).toBe(normalized.length);
  });

  it.each([
    ["재즈", "jazz"],
    ["락", "rock"],
    ["힙합", "hip-hop"],
    ["알앤비", "rnb"],
    ["제이팝", "j-pop"],
    [" City Pop ", "city pop"]
  ])("Last.fm용 장르 태그 %s를 %s로 정규화한다", (genre, expected) => {
    expect(resolveLastFmGenreTag(genre)).toBe(expected);
  });
});
