# Discord 음악 봇 MVP

Node.js와 `discord.js`로 Discord 명령을 처리하고, Lavalink가 YouTube 오디오 검색과 Discord 음성 전송을 담당하는 로컬 MVP입니다.

## 제공 기능

- `/재생`: 곡명 검색, YouTube 영상 URL, 최대 50곡의 YouTube 재생목록
- `/일시정지`, `/계속`, `/스킵`, `/정지`
- `/대기열`: 현재 곡과 다음 10곡 표시
- `/자동재생`: 마지막 곡 기반 YouTube Mix 추천 켜기·끄기
- 서버별 최대 100곡의 독립 대기열
- 청취자 또는 재생 요청이 5분 동안 없을 때 자동 퇴장

자동재생은 새 Player에서 기본적으로 켜집니다. 모든 상태는 메모리에만 있으므로 컨테이너를 재시작하면 대기열과 설정이 초기화됩니다.

## 처음 한 번 준비하기

### 1. Discord 애플리케이션 만들기

1. [Discord Developer Portal](https://discord.com/developers/applications)에서 `New Application`을 선택합니다.
2. `Bot` 메뉴에서 봇을 생성하고 Token을 발급합니다. Token은 비밀번호와 같으므로 공개하거나 Git에 커밋하면 안 됩니다.
3. `Installation`에서 `Guild Install`을 활성화합니다.
4. 설치 범위에 `bot`과 `applications.commands`를, 봇 권한에 `View Channels`, `Send Messages`, `Connect`, `Speak`를 선택합니다.
5. 생성된 설치 링크로 테스트 서버에 봇을 초대합니다.

Discord의 `Application ID`가 `DISCORD_CLIENT_ID`입니다. 테스트 서버 ID는 Discord의 개발자 모드를 켠 뒤 서버를 우클릭해 `서버 ID 복사`로 얻을 수 있습니다.

### 2. 환경 변수 만들기

```bash
cp .env.example .env
```

`.env`의 값을 실제 값으로 변경합니다.

```dotenv
DISCORD_TOKEN=Discord에서_발급한_봇_토큰
DISCORD_CLIENT_ID=애플리케이션_ID
DISCORD_GUILD_ID=테스트_서버_ID
LAVALINK_HOST=lavalink
LAVALINK_PORT=2333
LAVALINK_PASSWORD=충분히_긴_임의의_비밀번호
```

`LAVALINK_PASSWORD`는 Node.js 봇과 Lavalink가 서로를 인증할 때 사용합니다. 외부 서비스의 비밀번호가 아니라 이 프로젝트 안에서 직접 정하는 값입니다.

## 실행하기

먼저 이미지를 빌드합니다.

```bash
docker compose build
```

테스트 서버에 한국어 슬래시 명령 7개를 등록합니다.

```bash
docker compose run --rm bot node dist/deploy-commands.js
```

봇과 Lavalink를 백그라운드에서 실행합니다.

```bash
docker compose up -d
```

로그와 상태를 확인합니다.

```bash
docker compose ps
docker compose logs -f bot lavalink
```

종료할 때는 다음 명령을 사용합니다.

```bash
docker compose down
```

## 테스트와 품질 검사

호스트에 Node.js가 없어도 Docker의 `test` 빌드 단계에서 타입 검사, 37개 이상의 단위 테스트, 린트를 실행할 수 있습니다.

```bash
docker build --target test -t djscord-test .
```

## 구조

```text
src/domain          외부 라이브러리에 의존하지 않는 입력·대기열·추천 규칙
src/music           검색, 자동재생, 유휴 타이머 서비스
src/infrastructure  Lavalink 트랙과 내부 트랙의 변환
src/discord         슬래시 명령, 권한 검사, Discord 이벤트 처리
lavalink             Lavalink와 YouTube 소스 플러그인 설정
```

`discord.js`의 `Client`는 Discord Gateway 연결과 명령 이벤트를 담당합니다. `lavalink-client`의 `LavalinkManager`는 서버별 Player를 만들고 Discord 음성 상태를 Lavalink에 전달합니다. Lavalink의 `youtube-source` 플러그인이 YouTube 검색과 Mix 목록을 해석합니다.

### 처음 보는 라이브러리 이해하기

- `discord.js`는 Node.js에서 Discord API를 사용하는 라이브러리입니다. `new Client({ intents: [...] })` 형태로 접속 객체를 만들며, `intents`는 봇이 받을 Discord 이벤트의 종류입니다. 이 프로젝트는 서버 명령 처리를 위한 `Guilds`와 음성 채널 상태 감지를 위한 `GuildVoiceStates`만 요청합니다.
- `lavalink-client`는 Node.js 봇과 별도 Lavalink 오디오 서버를 연결하는 라이브러리입니다. `new LavalinkManager({ client, nodes, playerOptions, sendToShard })` 형태로 사용합니다. 여기서 `client`는 Discord 봇 ID, `nodes`는 Lavalink 주소·포트·비밀번호, `playerOptions`는 자동재생과 연결 복구 정책, `sendToShard`는 Lavalink가 만든 음성 연결 데이터를 Discord로 보내는 함수입니다.
- `zod`는 실행 전에 환경 변수의 형태를 검사하는 검증 라이브러리입니다. `z.object({...}).safeParse(process.env)` 형태로 사용하며, 현재 코드는 Discord ID·토큰의 존재 여부, Lavalink 비밀번호 길이, 포트가 올바른 정수인지 검사합니다. 설정이 잘못되면 봇이 애매한 연결 오류 대신 어떤 값을 고쳐야 하는지 바로 알려줍니다.
- Lavalink는 Spring으로 직접 작성한 애플리케이션 코드가 아니라, 이미 빌드된 독립 Java 서버를 Docker 이미지로 실행합니다. 봇은 Lavalink에 검색·재생을 요청하고, Lavalink가 YouTube 소스 해석과 Discord용 오디오 전송을 담당합니다.

## 제한사항

- 공개 서비스나 상업적 사용을 위한 음원 권한은 포함하지 않습니다.
- YouTube 내부 변경이나 요청 제한으로 재생이 실패할 수 있습니다.
- 데이터베이스가 없어 재시작 복구를 지원하지 않습니다.
- Docker Compose를 사용하는 로컬 단일 인스턴스만 대상으로 합니다.

공개 배포 전에 YouTube 이용 정책과 음원 재전송 권한을 별도로 검토해야 합니다.
