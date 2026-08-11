export interface GenreArtistSeed {
  aliases: readonly string[];
  artist: string;
  query: string;
}

export interface GenreSeedProfile {
  aliases: readonly string[];
  id: string;
  seeds: readonly GenreArtistSeed[];
}

export const GENRE_SEED_PROFILES: readonly GenreSeedProfile[] = [
  {
    aliases: ["케이팝"],
    id: "k-pop",
    seeds: [
      artistSeed("BTS", ["방탄소년단"]),
      artistSeed("BLACKPINK", ["블랙핑크"]),
      artistSeed("aespa", ["에스파"]),
      artistSeed("IVE", ["아이브"]),
      artistSeed("Stray Kids", ["스트레이 키즈"]),
      artistSeed("NewJeans", ["뉴진스"])
    ]
  }
];

const profilesByAlias = new Map<string, GenreSeedProfile>();
for (const profile of GENRE_SEED_PROFILES) {
  for (const alias of [profile.id, ...profile.aliases]) {
    profilesByAlias.set(normalizeGenreAlias(alias), profile);
  }
}

export function resolveGenreSeedProfile(genre: string): GenreSeedProfile | undefined {
  return profilesByAlias.get(normalizeGenreAlias(genre));
}

function artistSeed(artist: string, aliases: readonly string[] = []): GenreArtistSeed {
  return {
    aliases: [artist, ...aliases],
    artist,
    query: `${artist} official music video`
  };
}

function normalizeGenreAlias(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[\s_-]+/g, "");
}
