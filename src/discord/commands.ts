import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

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
  new SlashCommandBuilder()
    .setName("반복")
    .setDescription("현재 곡 또는 대기열 전체 반복을 설정합니다.")
    .addStringOption((option) =>
      option
        .setName("모드")
        .setDescription("반복 방식")
        .setRequired(true)
        .addChoices(
          { name: "끄기", value: "off" },
          { name: "한 곡", value: "track" },
          { name: "대기열 전체", value: "queue" }
        )
    ),
  new SlashCommandBuilder().setName("셔플").setDescription("대기열의 다음 곡 순서를 섞습니다."),
  new SlashCommandBuilder()
    .setName("삭제")
    .setDescription("대기열에서 곡을 제거합니다.")
    .addIntegerOption((option) =>
      option
        .setName("번호")
        .setDescription("/대기열에 표시된 다음 곡 번호")
        .setRequired(true)
        .setMinValue(1)
    ),
  new SlashCommandBuilder()
    .setName("이동")
    .setDescription("대기열의 곡 순서를 변경합니다.")
    .addIntegerOption((option) =>
      option.setName("곡").setDescription("이동할 곡 번호").setRequired(true).setMinValue(1)
    )
    .addIntegerOption((option) =>
      option.setName("위치").setDescription("옮길 위치 번호").setRequired(true).setMinValue(1)
    ),
  new SlashCommandBuilder()
    .setName("탐색")
    .setDescription("현재 곡의 재생 위치를 이동합니다.")
    .addStringOption((option) =>
      option
        .setName("시간")
        .setDescription("예: 90, 1:30, 1:02:03")
        .setRequired(true)
        .setMaxLength(8)
    ),
  new SlashCommandBuilder()
    .setName("볼륨")
    .setDescription("이 서버의 현재 재생 볼륨을 조절합니다.")
    .addIntegerOption((option) =>
      option
        .setName("값")
        .setDescription("0(음소거)~100")
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(100)
    ),
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
    ),
  new SlashCommandBuilder()
    .setName("설정")
    .setDescription("이 서버의 음악 재생 기본값을 확인하거나 변경합니다.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addIntegerOption((option) =>
      option
        .setName("기본볼륨")
        .setDescription("새 재생 세션의 기본 볼륨 (0~100)")
        .setMinValue(0)
        .setMaxValue(100)
    )
    .addStringOption((option) =>
      option
        .setName("자동재생")
        .setDescription("새 재생 세션의 자동 추천 기본값")
        .addChoices({ name: "켜기", value: "on" }, { name: "끄기", value: "off" })
    ),
  new SlashCommandBuilder()
    .setName("좋아요")
    .setDescription("현재 곡을 내 즐겨찾기에 저장합니다."),
  new SlashCommandBuilder()
    .setName("내음악")
    .setDescription("내가 즐겨찾기에 저장한 곡을 확인합니다."),
  new SlashCommandBuilder()
    .setName("플레이리스트")
    .setDescription("내 플레이리스트를 저장하고 재생합니다.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("저장")
        .setDescription("현재 곡과 대기열을 저장합니다.")
        .addStringOption((option) =>
          option
            .setName("이름")
            .setDescription("저장할 플레이리스트 이름")
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(40)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("목록").setDescription("저장한 플레이리스트 목록을 확인합니다.")
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("재생")
        .setDescription("저장한 플레이리스트를 대기열에 추가합니다.")
        .addStringOption((option) =>
          option
            .setName("이름")
            .setDescription("재생할 플레이리스트 이름")
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(40)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("삭제")
        .setDescription("저장한 플레이리스트를 삭제합니다.")
        .addStringOption((option) =>
          option
            .setName("이름")
            .setDescription("삭제할 플레이리스트 이름")
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(40)
        )
    ),
  new SlashCommandBuilder()
    .setName("사용법")
    .setDescription("음악 봇의 명령과 플레이어 사용법을 확인합니다.")
];
