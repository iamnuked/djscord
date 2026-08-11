import { SlashCommandBuilder } from "discord.js";

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName("재생")
    .setDescription("YouTube 음악을 검색하거나 링크를 재생합니다.")
    .addStringOption((option) =>
      option
        .setName("검색어")
        .setDescription("곡 제목, YouTube 영상 URL 또는 재생목록 URL")
        .setRequired(true)
    ),
  new SlashCommandBuilder().setName("일시정지").setDescription("현재 곡을 일시정지합니다."),
  new SlashCommandBuilder().setName("계속").setDescription("일시정지된 곡을 이어서 재생합니다."),
  new SlashCommandBuilder().setName("스킵").setDescription("현재 곡을 건너뜁니다."),
  new SlashCommandBuilder().setName("대기열").setDescription("현재 곡과 다음 곡을 확인합니다."),
  new SlashCommandBuilder()
    .setName("자동재생")
    .setDescription("추천곡 자동재생을 켜거나 끕니다.")
    .addStringOption((option) =>
      option
        .setName("모드")
        .setDescription("자동재생 상태")
        .setRequired(true)
        .addChoices({ name: "켜기", value: "on" }, { name: "끄기", value: "off" })
    ),
  new SlashCommandBuilder().setName("정지").setDescription("재생을 끝내고 음성 채널에서 나갑니다."),
  new SlashCommandBuilder()
    .setName("장르")
    .setDescription("장르에 맞는 YouTube 플레이리스트를 만듭니다.")
    .addStringOption((option) =>
      option
        .setName("이름")
        .setDescription("예: 재즈, K-pop, 2000년대 록")
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName("곡수")
        .setDescription("만들 곡 수 (기본 20곡)")
        .setMinValue(5)
        .setMaxValue(30)
    )
];
