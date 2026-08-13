# Discord 음악 봇 MVP

Node.js와 `discord.js`로 Discord 명령을 처리하고, Lavalink가 YouTube 오디오 검색과 Discord 음성 전송을 담당하는 음악 봇입니다. 슬래시 명령은 전역으로 등록되어 앱을 설치한 모든 서버에서 사용할 수 있습니다.

## 제공 기능

- `/재생`: 곡명 검색, YouTube 영상 URL, 최대 50곡의 YouTube 재생목록
- `/장르`: 장르 이름으로 YouTube 검색·Mix 후보를 만들고, 미리보기에서 곡을 제거한 뒤 대기열에 추가
  - K-pop은 BTS·BLACKPINK·aespa·IVE·Stray Kids·NewJeans의 대표 시드를 라운드 로빈으로 섞어 특정 검색 결과에 치우치는 현상을 줄임
  - Last.fm API 키가 있으면 등록되지 않은 장르의 상위 아티스트 6명을 여러 Mix 시드로 사용
  - Last.fm 장애나 API 키 미설정 시 기존 YouTube Music 검색과 일반 YouTube 검색 폴백을 그대로 사용
- `/디제이 목록|시작|일시정지|계속|스킵|종료`: sibling `djengine`의 레코드박스 플레이리스트를 자동 선곡·전환한 라이브 믹스로 재생·제어
  - 에너지 흐름(`일정하게`, `워밍업`, `빌드업`, `피크`, `쿨다운`)과 5~120분 재생 시간 선택(기본 60분)
  - 웹 믹싱 화면에서 두 덱의 파형·재생 위치·EQ·전환 상태를 확인
  - DJ 모드에서는 `/디제이` 전용 제어와 `/볼륨`만 허용하며 기존 음악 명령과 플레이어 버튼은 비활성화
- `/일시정지`, `/계속`, `/스킵`, `/정지`
- `/반복`, `/셔플`, `/삭제`, `/이동`, `/탐색`, `/볼륨`: 반복 모드와 대기열 순서, 재생 위치, 음량 제어
- `/대기열`: 현재 곡과 다음 10곡 표시
- `/자동재생`: 마지막 곡 기반 YouTube Mix 추천 켜기·끄기
- `/설정`: 서버 관리자가 새 재생 세션의 기본 볼륨과 자동재생 기본값 관리
- `/좋아요`, `/내음악`: 현재 곡을 개인 즐겨찾기에 영구 저장하고 조회
- `/플레이리스트 저장|목록|재생|삭제`: 현재 곡과 대기열을 개인 목록으로 영구 저장
- `/사용법`: 빠른 시작, 전체 명령과 플레이어 버튼을 요청자에게만 보이는 안내 카드로 표시
- 채팅 플레이어: 앨범형 카드와 아이콘 제어 버튼을 한 메시지에서 갱신하며 반복·볼륨 상태 표시
- 추천 피드백: `👍` 곡을 서버 추천 시드로 저장하고 `👎` 곡·반복해서 싫어요를 받은 아티스트 제외
- 선택적 Ko-fi 후원 버튼: 설정한 공식 Ko-fi 페이지를 플레이어에서 바로 열기
- 서버별 최대 100곡의 독립 대기열
- 청취자 또는 재생 요청이 5분 동안 없을 때 자동 퇴장

자동재생과 기본 볼륨은 서버별로 설정할 수 있습니다. 현재 대기열과 재생 세션은 메모리에만 있어 재시작하면 초기화되지만, 서버 설정·즐겨찾기·저장 플레이리스트·추천 피드백은 SQLite에 유지됩니다.

## 처음 한 번 준비하기

### 1. Discord 애플리케이션 만들기

1. [Discord Developer Portal](https://discord.com/developers/applications)에서 `New Application`을 선택합니다.
2. `Bot` 메뉴에서 봇을 생성하고 Token을 발급합니다. Token은 비밀번호와 같으므로 공개하거나 Git에 커밋하면 안 됩니다.
3. `Installation`에서 `Guild Install`을 활성화합니다.
4. 설치 범위에 `bot`과 `applications.commands`를, 봇 권한에 `View Channels`, `Send Messages`, `Embed Links`, `Connect`, `Speak`를 선택합니다.
5. 생성된 설치 링크로 테스트 서버에 봇을 초대합니다.

Discord의 `Application ID`가 `DISCORD_CLIENT_ID`입니다. 전역 명령을 사용하므로 특정 테스트 서버 ID는 필요하지 않습니다.

### 2. 환경 변수 만들기

```bash
cp .env.example .env
```

`.env`의 값을 실제 값으로 변경합니다.

```dotenv
DISCORD_TOKEN=Discord에서_발급한_봇_토큰
DISCORD_CLIENT_ID=애플리케이션_ID
KOFI_URL=https://ko-fi.com/내_Ko-fi_아이디
LASTFM_API_KEY=Last.fm에서_발급한_API_키
DATABASE_PATH=/data/djscord.sqlite
LAVALINK_HOST=lavalink
LAVALINK_PORT=2333
LAVALINK_PASSWORD=충분히_긴_임의의_비밀번호
# DJ Engine을 사용할 때만 아래 네 값을 추가합니다(마지막 두 값은 Compose mount 경로입니다).
DJENGINE_API_KEY=32바이트_이상의_임의_문자열
DJENGINE_BASE_URL=http://engine:8787
DJENGINE_HOST_MUSIC_ROOT=/음악_폴더의_절대경로
DJENGINE_HOST_REKORDBOX_XML=/rekordbox.xml의_절대경로
# 웹 믹싱 화면을 사용할 때만 아래 세 값을 모두 추가합니다.
MIX_INGEST_URL=https://웹사이트_호스트/api/internal/v1
MIX_INGEST_SECRET=32바이트_이상의_임의_문자열
MIX_PUBLIC_URL=https://웹사이트_호스트/mix
```

`LAVALINK_PASSWORD`는 Node.js 봇과 Lavalink가 서로를 인증할 때 사용합니다. 외부 서비스의 비밀번호가 아니라 이 프로젝트 안에서 직접 정하는 값입니다.

`KOFI_URL`은 선택값입니다. `https://ko-fi.com/아이디` 형태의 본인 후원 페이지를 넣으면 플레이어 카드에 `☕ 서버비 지원` 링크 버튼이 나타납니다. 설정하지 않으면 후원 버튼만 숨겨지고 음악 기능은 그대로 동작합니다.

`LASTFM_API_KEY`도 선택값입니다. [Last.fm API 계정 페이지](https://www.last.fm/api/account/create)에서 키를 발급해 넣으면 K-pop 외 장르도 해당 태그의 상위 아티스트 6명을 대표 시드로 사용합니다. 같은 장르 결과는 프로세스 메모리에 24시간 보관해 API 호출을 줄입니다. 키가 없거나 Last.fm 요청이 실패하면 기존 YouTube 검색으로 자동 폴백합니다. Last.fm의 무료 API 이용은 기본적으로 비상업 용도이므로 공개·수익화 전에 [API 이용약관](https://www.last.fm/api/tos)을 확인해야 합니다.

`DJENGINE_API_KEY`와 `DJENGINE_BASE_URL`은 둘 다 설정하거나 둘 다 생략해야 합니다. API 키는 문자 수가 아니라 UTF-8 기준 32바이트 이상이어야 합니다. `DJENGINE_HOST_MUSIC_ROOT`는 음원이 든 가장 좁은 상위 폴더, `DJENGINE_HOST_REKORDBOX_XML`은 레코드박스에서 내보낸 XML 파일입니다. Compose는 두 경로를 읽기 전용으로만 엔진에 전달합니다. 스트림 URL에는 세션 전용 비밀 token이 들어 있으므로 봇은 이를 Discord 메시지, 플레이어 카드, SQLite에 표시하거나 저장하지 않습니다.

`MIX_INGEST_URL`, `MIX_INGEST_SECRET`, `MIX_PUBLIC_URL`은 웹 믹싱 화면을 사용할 때 세 값을 모두 설정해야 합니다. 봇은 엔진의 실시간 상태와 파형을 HMAC-SHA256 서명(공유 비밀키로 요청 위조 여부를 확인하는 방식)으로 웹 ingest API에 전달하고, 성공한 `/디제이 시작` 응답에 해당 서버의 믹싱 화면 링크를 표시합니다.

`DATABASE_PATH`는 선택값이며 기본값은 `/data/djscord.sqlite`입니다. Compose의 `bot-data` 볼륨이 이 경로를 보존하므로 `docker compose down`이나 이미지 재빌드 뒤에도 저장 정보가 남습니다. 데이터를 완전히 지우려는 경우에만 `docker compose down -v`를 사용하세요.

## 실행하기

먼저 이미지를 빌드합니다.

```bash
docker compose build
```

설치된 모든 서버에 한국어 전역 슬래시 명령 20개를 등록합니다. 명령 정의를 변경한 뒤에도 이 명령을 다시 실행해야 합니다.

```bash
docker compose run --rm bot node dist/deploy-commands.js
```

이전 버전에서 Guild 전용 명령을 등록했다면 해당 서버의 기존 Guild 명령을 비워야 최신 전역 명령이 가려지지 않습니다. 전역 명령 등록 후 Discord 클라이언트를 새로고침하세요.

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

### DJ Engine과 함께 실행하기

이 저장소와 `djengine` 저장소가 같은 상위 폴더에 있을 때 선택적 Compose overlay를 사용할 수 있습니다.

```text
projects/
├── djscord/
└── djengine/
```

먼저 레코드박스에서 컬렉션 XML을 내보내고, 임의 API 키를 만듭니다.

```bash
openssl rand -base64 48
```

출력값과 음악/XML 절대경로를 앞 절의 `.env` 변수에 넣은 뒤 세 서비스를 함께 실행합니다.

```bash
docker compose -f compose.yaml -f compose.djengine.yaml up --build -d
```

처음 한 번 또는 `djengine`의 분석 규칙을 튜닝한 뒤에는 라이브러리를 다시 가져와야 합니다. 아래 `curl`은 HTTP 요청을 보내는 명령줄 도구이고, `POST`는 서버에 새 가져오기 작업을 생성한다는 뜻입니다. `Authorization` 헤더에는 `.env`의 API 키를 전달합니다.

```bash
docker compose -f compose.yaml -f compose.djengine.yaml exec engine \
  sh -c 'curl -sS -X POST http://127.0.0.1:8787/api/v1/libraries/default/imports -H "Authorization: Bearer $DJENGINE_API_KEY"'
```

가져오기·분석이 끝나면 Discord에서 다음 순서로 사용합니다.

```text
/디제이 목록
/디제이 시작 플레이리스트:<자동완성 선택> 에너지:빌드업 시간:60
/디제이 일시정지
/디제이 계속
/디제이 스킵
/디제이 종료
```

DJ Engine은 두 곡 이상 분석된 플레이리스트가 필요합니다. 믹스 전체가 하나의 라이브 스트림이므로 `/디제이` 전용 제어와 `/볼륨`을 제외한 명령 및 플레이어 버튼은 DJ 모드에서 비활성화됩니다. `/디제이 스킵`은 스트림을 종료하지 않고 엔진 내부의 다음 곡으로 이동하며, 일시정지·계속·스킵은 음악의 다음 마디 경계에 맞춰 실행됩니다.

## AWS에 배포하기

서울 리전의 EC2 한 대에 ECR 이미지와 Docker Compose로 배포하는 운영 구성이 포함되어 있습니다. CloudFormation으로 외부 인바운드가 없는 EC2, 암호화된 EBS, ECR, S3 릴리스 버킷, CloudWatch 로그 그룹과 최소 권한 EC2 역할을 생성합니다.

계정 로그인, 과금 리소스 생성, Parameter Store 비밀값 등록, 이미지 게시, 원격 배포와 롤백 순서는 [AWS EC2 배포 가이드](docs/aws-deployment.md)를 따르세요.

## 테스트와 품질 검사

호스트에 Node.js가 없어도 Docker의 `test` 빌드 단계에서 타입 검사, 120개 이상의 단위·통합 테스트, 린트를 실행할 수 있습니다.

```bash
docker build --target test -t djscord-test .
docker run --rm --entrypoint npm djscord-test run test:coverage
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
- `EmbedBuilder`는 `discord.js`에서 제목·썸네일·필드를 가진 카드형 메시지를 만드는 클래스입니다. `new EmbedBuilder().setTitle(...).addFields(...)` 형태로 내용을 조립합니다. 현재 코드는 곡 정보와 진행 상태를 보기 쉽게 표시하기 위해 사용하며, 봇 역할에 `Embed Links` 권한이 필요합니다.
- `ButtonBuilder`와 `StringSelectMenuBuilder`는 `discord.js`의 메시지 입력 컴포넌트를 만드는 클래스입니다. 각각 `.setCustomId(...)`로 클릭 이벤트를 구분하고, `.setLabel(...)` 또는 `.addOptions(...)`로 화면 내용을 정합니다. 플레이어 제어 버튼과 장르 미리보기의 다중 선택 목록에 사용합니다.
- `lavalink-client`는 Node.js 봇과 별도 Lavalink 오디오 서버를 연결하는 라이브러리입니다. `new LavalinkManager({ client, nodes, playerOptions, sendToShard })` 형태로 사용합니다. 여기서 `client`는 Discord 봇 ID, `nodes`는 Lavalink 주소·포트·비밀번호, `playerOptions`는 자동재생과 연결 복구 정책, `sendToShard`는 Lavalink가 만든 음성 연결 데이터를 Discord로 보내는 함수입니다.
- `zod`는 실행 전에 환경 변수의 형태를 검사하는 검증 라이브러리입니다. `z.object({...}).safeParse(process.env)` 형태로 사용하며, 현재 코드는 Discord ID·토큰의 존재 여부, Lavalink 비밀번호 길이, 포트가 올바른 정수인지 검사합니다. 설정이 잘못되면 봇이 애매한 연결 오류 대신 어떤 값을 고쳐야 하는지 바로 알려줍니다.
- `LastFmGenreArtistProvider`는 Last.fm의 `tag.getTopArtists` HTTP API를 이 봇의 장르 시드 형식으로 바꾸는 어댑터 클래스입니다. `new LastFmGenreArtistProvider({ apiKey })`로 생성하고 `getTopArtists(genre, limit)`에 장르 태그와 가져올 인원 수를 넘깁니다. 현재 코드는 API 키, 5초 타임아웃, 식별 가능한 User-Agent를 사용하며 결과를 24시간 캐시합니다. Node.js 내장 `fetch`가 HTTP 요청을 보내고, 기존 `zod`가 응답 구조를 검사합니다.
- `DjEngineClient`는 DJ Engine REST API를 호출하는 작은 HTTP 클라이언트입니다. 별도 라이브러리 없이 Node.js 내장 `fetch(url, options)`를 사용합니다. `url`은 요청 주소이고 `options.method`, `options.headers`, `options.body`는 각각 HTTP 동작, 인증 정보, JSON 요청 본문입니다. 현재 코드는 `baseUrl`과 32바이트 이상 `apiKey`를 받아 플레이리스트 조회, 세션 생성·제어·종료와 완료 이벤트 감시를 담당합니다.
- `DjPlaybackService`는 Discord나 HTTP 세부 구현과 분리된 DJ 재생 수명주기 서비스입니다. `new DjPlaybackService(engine)`로 API 클라이언트를 주입하고 `start(...)`에 서버·사용자·플레이리스트·Lavalink Player 정보를 넘깁니다. 세션 생성 → 준비 대기 → Ogg 스트림 로드 → 재생 순서를 보장하며, 실패·자연 종료·봇 종료 때 엔진 세션을 한 번만 닫습니다.
- `MixIngestClient`와 `DjMixPublisher`는 선택적인 웹 믹싱 화면으로 상태를 전달합니다. 전자는 Node.js 내장 `fetch`로 스냅샷과 파형을 HMAC 서명해 전송하고, 후자는 DJ Engine의 실시간 이벤트를 구독해 전송 순서와 종료 정리를 관리합니다. `new MixIngestClient({ baseUrl, secret })`에는 HTTPS API 주소와 공유 비밀키를, `new DjMixPublisher(engine, ingest)`에는 엔진 클라이언트와 ingest 클라이언트를 넘깁니다.
- `DatabaseSync`는 Node.js 22의 내장 `node:sqlite` 모듈이 제공하는 SQLite 연결 클래스입니다. `new DatabaseSync(path)`로 파일을 열고 `prepare(sql).run(...)`으로 값을 저장하거나 `prepare(sql).get(...)`으로 한 행을 읽습니다. 현재 코드는 `path`에 `DATABASE_PATH`를 넘기고, SQL의 `?` 자리에 Discord 서버 ID·사용자 ID·트랙 정보를 별도 인자로 전달해 문자열 결합으로 SQL을 만들지 않습니다. 즐겨찾기, 저장 플레이리스트, 서버 설정, 추천 피드백을 별도 DB 서버 없이 보존하기 위해 사용합니다.
- `PermissionFlagsBits.ManageGuild`는 `discord.js`가 제공하는 Discord 권한 상수로, 사용자가 `서버 관리` 권한을 갖는지 나타냅니다. `/설정` 명령의 기본 권한과 실행 시 권한 검사에 사용해 일반 사용자가 서버 전체 기본값을 바꾸지 못하게 합니다.
- Lavalink는 Spring으로 직접 작성한 애플리케이션 코드가 아니라, 이미 빌드된 독립 Java 서버를 Docker 이미지로 실행합니다. 봇은 Lavalink에 검색·재생을 요청하고, Lavalink가 YouTube 소스 해석과 Discord용 오디오 전송을 담당합니다.

## 제한사항

- 공개 서비스나 상업적 사용을 위한 음원 권한은 포함하지 않습니다.
- DJ Engine의 Rubber Band 사용 조건은 공개·유료·재배포 전에 sibling 저장소의 `THIRD_PARTY_NOTICES.md`에서 별도로 해결해야 합니다.
- 정상적인 `/디제이 종료`와 봇 종료는 DJ Engine 세션을 정리하지만, 프로세스가 `SIGKILL`이나 호스트 장애로 즉시 사라지면 엔진에 세션이 남을 수 있습니다. 현재 엔진에는 소유자별 복구 API나 만료 시간이 없으므로 이런 경우 DJ Engine을 재시작해 고아 세션을 정리해야 합니다.
- YouTube 내부 변경이나 요청 제한으로 재생이 실패할 수 있습니다.
- 재생 중인 곡과 대기열 자체는 재시작 복구를 지원하지 않습니다.
- SQLite 단일 파일을 사용하므로 여러 봇 인스턴스가 동시에 같은 DB 파일을 공유하는 수평 확장 구성은 지원하지 않습니다.

공개 배포 전에 YouTube 이용 정책과 음원 재전송 권한을 별도로 검토해야 합니다.
