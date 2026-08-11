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

const lastFmGenreAliases = new Map<string, string>([
  ["팝", "pop"],
  ["팝음악", "pop"],
  ["락", "rock"],
  ["락음악", "rock"],
  ["록", "rock"],
  ["록음악", "rock"],
  ["힙합", "hip-hop"],
  ["랩", "hip-hop"],
  ["알앤비", "rnb"],
  ["리듬앤블루스", "rnb"],
  ["재즈", "jazz"],
  ["클래식", "classical"],
  ["고전음악", "classical"],
  ["메탈", "metal"],
  ["인디", "indie"],
  ["일렉트로닉", "electronic"],
  ["전자음악", "electronic"],
  ["이디엠", "edm"],
  ["레게", "reggae"],
  ["라틴", "latin"],
  ["컨트리", "country"],
  ["제이팝", "j-pop"],
  ["로파이", "lo-fi"]
]);

const profilesByAlias = new Map<string, GenreSeedProfile>();
for (const profile of GENRE_SEED_PROFILES) {
  for (const alias of [profile.id, ...profile.aliases]) {
    profilesByAlias.set(normalizeGenreAlias(alias), profile);
  }
}

export function resolveGenreSeedProfile(genre: string): GenreSeedProfile | undefined {
  return profilesByAlias.get(normalizeGenreAlias(genre));
}

export function resolveLastFmGenreTag(genre: string): string {
  const normalized = genre
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
  const profile = resolveGenreSeedProfile(normalized);
  return (
    profile?.id ??
    lastFmGenreAliases.get(normalizeGenreAlias(normalized)) ??
    normalized
  );
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
