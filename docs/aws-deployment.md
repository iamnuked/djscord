# AWS EC2 배포 가이드

이 문서는 서울 리전의 EC2 한 대에서 `bot`, `djengine`, `lavalink` 컨테이너를 Docker Compose로 운영하는 절차입니다. 웹 브라우저용 서버가 아니므로 로드 밸런서, 도메인, HTTPS 인증서와 외부 인바운드 포트는 사용하지 않습니다. 믹스 상태는 봇이 외부 Cloudflare 사이트로 서명해 전송합니다.

## 구성 이해하기

- **CloudFormation**은 AWS 리소스 구성을 YAML 파일로 기록하고 같은 구성을 반복 생성하는 AWS 서비스입니다. `deploy/provision.sh`는 `aws cloudformation deploy` 명령으로 `infra/aws/djscord-ec2.yaml`을 적용합니다. `--stack-name`은 묶음 이름, `--parameter-overrides`는 템플릿에 VPC와 서브넷 값을 전달하는 옵션입니다.
- **ECR**은 비공개 Docker 이미지 저장소입니다. 봇과 djengine 이미지를 각각 저장하고 EC2가 실행할 불변 이미지 태그를 내려받습니다.
- **Parameter Store**는 Discord 토큰과 API 키를 보관합니다. `SecureString` 값은 암호화되며 EC2 역할만 `/djscord/prod/*`를 읽을 수 있습니다.
- **S3 릴리스 버킷**은 Compose 파일과 배포 스크립트만 저장합니다. Discord 토큰은 릴리스 파일에 포함되지 않습니다.
- **Systems Manager Run Command**는 SSH 포트를 열지 않고 EC2에서 배포 명령을 실행합니다.

CloudFormation 스택은 EC2, 암호화된 30GB gp3 EBS, 퍼블릭 IPv4, ECR 및 로그 저장소를 만듭니다. 실행하는 순간부터 AWS 비용이 발생할 수 있습니다.

## 1. 로컬 AWS 로그인

장기 액세스 키가 아닌 `aws login` 프로필을 사용합니다.

```bash
aws login --profile djscord-prod
export AWS_PROFILE=djscord-prod
export AWS_REGION=ap-northeast-2
aws configure list
aws sts get-caller-identity
```

`aws configure list`의 `access_key`와 `secret_key` 타입이 `login`이어야 합니다. 계정 ID를 확인한 뒤에만 다음 단계로 진행합니다.

## 2. 기본 VPC와 퍼블릭 서브넷 확인

VPC는 AWS 안에서 서버가 사용하는 사설 네트워크입니다. 새 계정의 기본 VPC를 조회합니다.

```bash
VPC_ID=$(aws ec2 describe-vpcs \
  --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' \
  --output text)

aws ec2 describe-subnets \
  --filters Name=vpc-id,Values="$VPC_ID" \
  --query 'Subnets[].{SubnetId:SubnetId,AZ:AvailabilityZone,PublicIp:MapPublicIpOnLaunch}' \
  --output table
```

표에서 `PublicIp`이 `True`인 서브넷 하나를 선택합니다.

```bash
SUBNET_ID=subnet-선택한값
```

기본 VPC가 없다면 이 스크립트를 실행하지 말고 VPC와 인터넷 게이트웨이를 먼저 구성해야 합니다.

## 3. AWS 인프라 생성

다음 명령은 실제 과금 리소스를 생성합니다.

```bash
./deploy/provision.sh "$VPC_ID" "$SUBNET_ID"
```

생성되는 핵심 리소스는 다음과 같습니다.

- `t3.medium` Amazon Linux 2023 EC2
- 외부 인바운드 규칙이 없는 보안 그룹
- 암호화된 30GB gp3 루트 볼륨
- `djscord/bot`, `djscord/engine` ECR 저장소
- 비공개 S3 릴리스 버킷
- `/djscord/prod/bot`, `/djscord/prod/engine`, `/djscord/prod/lavalink` CloudWatch 로그 그룹
- Session Manager, ECR 읽기, Parameter Store 읽기만 허용한 EC2 역할

EC2 초기화 중 Docker와 Docker Compose 플러그인을 설치합니다. 완료까지 몇 분 걸릴 수 있습니다.

## 4. 비밀값 등록

로컬 `.env` 값을 Parameter Store로 복사합니다.

```bash
./deploy/push-secrets.sh .env
```

이 스크립트에서 사용하는 `aws ssm put-parameter`는 Parameter Store 값을 생성하거나 `--overwrite` 옵션으로 갱신합니다. `--type SecureString`은 Discord 토큰, Last.fm 키와 Lavalink 비밀번호를 암호화해 저장한다는 뜻입니다. 실제 값은 터미널에 출력하지 않습니다.

필수 값:

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `LAVALINK_PASSWORD`
- `DJENGINE_API_KEY`

선택 값:

- `KOFI_URL`
- `LASTFM_API_KEY`
- 웹 믹싱 화면을 사용할 때만 `MIX_INGEST_URL`, `MIX_INGEST_SECRET`, `MIX_PUBLIC_URL` 세 값을 모두 설정합니다. 셋을 모두 생략하면 `push-secrets.sh`가 기존의 세 Parameter Store 값도 제거해 publisher를 비활성화합니다. 일부만 설정하면 잘못된 구성을 막기 위해 값을 변경하기 전에 스크립트가 중단됩니다.

`KOFI_URL`이나 `LASTFM_API_KEY`를 로컬 `.env`에서 지워도 기존 Parameter Store 값은 자동 삭제되지 않습니다. 이 두 값을 지우려면 AWS 콘솔에서 해당 값만 직접 확인한 뒤 제거합니다. Mix 세 값은 위에서 설명한 것처럼 예외적으로 그룹 전체가 자동 삭제됩니다.

## 5. 이미지와 릴리스 게시

모든 테스트를 먼저 실행합니다.

```bash
docker build --target test -t djscord-test .
```

테스트가 통과하면 현재 `djscord`와 sibling `djengine` Git 커밋을 각각 x86 EC2용 이미지로 만들고 ECR과 S3에 게시합니다. 두 저장소에 커밋되지 않은 소스가 있으면 서로 다른 버전이 섞이지 않도록 게시를 중단합니다. 로컬 입력 파일인 sibling 저장소 최상위의 `rekordbox.xml`만 검사에서 제외하며 이미지에도 포함하지 않습니다.

```bash
./deploy/publish-release.sh
```

`docker buildx build`는 Mac의 ARM CPU와 다른 `linux/amd64` 이미지를 만들 수 있는 Docker 빌드 기능입니다. 스크립트는 `--platform linux/amd64`, 운영 단계인 `--target production`, ECR에 바로 업로드하는 `--push`를 사용합니다. 이미지는 `latest` 대신 Git 커밋 해시로 고정합니다.

출력 마지막에 다음과 같은 명령이 표시됩니다.

```bash
./deploy/remote-deploy.sh 봇12자리커밋해시 엔진12자리커밋해시
```

## 6. EC2에 원격 배포

로컬에서 실행 중인 같은 봇을 먼저 중지해 Discord 음성 연결 충돌을 막습니다.

```bash
docker compose down
```

게시 명령에서 출력된 태그로 배포합니다.

```bash
./deploy/remote-deploy.sh 봇12자리커밋해시 엔진12자리커밋해시
```

이 스크립트는 Systems Manager의 `AWS-RunShellScript` 문서로 다음 작업을 수행합니다.

1. S3 릴리스 파일 다운로드
2. `/opt/djengine/music`과 `/opt/djengine/config/rekordbox.xml`이 읽기 가능한지 검증
3. Parameter Store로 `/opt/djscord/.env` 생성
4. 봇과 djengine ECR 이미지 다운로드
5. `docker compose up -d` 실행
6. djengine, Lavalink, 봇 상태가 `healthy`인지 최대 3분 동안 확인
7. 실행 결과와 오류를 로컬 터미널에 출력

봇 상태 점검은 `/tmp/djscord-health.json`의 신호를 읽습니다. Discord 클라이언트와 Lavalink 노드가 모두 연결되고, 신호가 45초보다 오래되지 않았을 때만 정상입니다.

## 7. Discord 검증

명령 정의를 변경하지 않았다면 전역 슬래시 명령을 다시 등록할 필요가 없습니다. 변경했다면 EC2의 `DEPLOY_COMMANDS=1` 배포 옵션 대신 첫 배포 후 별도로 한 번 실행하는 것을 권장합니다.

다음을 차례로 확인합니다.

1. `/사용법`
2. `/재생`으로 한 곡 재생
3. 일시정지, 계속, 스킵 버튼
4. `/장르`
5. `/좋아요` 또는 서버 설정 저장
6. 봇 컨테이너 재시작 뒤 저장값 유지

DJ 기능은 아래 통합 흐름을 별도로 확인합니다. 먼저 뒤의 **운영 음원 준비** 절차로 import와 플레이리스트 검증을 끝내야 합니다.

1. 음성 채널에서 `/디제이 목록`과 `/디제이 시작`을 실행하고 Lavalink가 하나의 믹스 스트림을 재생하는지 확인
2. 시작 응답의 `/mix?guild=...` 링크를 같은 서버 구성원 계정으로 열어 Deck A/B 파형과 실제 재생 위치 확인
3. 해당 서버에 속하지 않은 별도 계정에서는 같은 guild URL이 `404`로 숨겨지는지 확인
4. `/디제이 일시정지`, `/디제이 계속`, `/디제이 스킵`이 다음 마디에서 오디오와 웹에 함께 반영되는지 확인
5. `/디제이 종료` 뒤 웹 목록에서 사라지고, 종료 snapshot은 최대 60초 동안 기존 화면에만 남는지 확인

기본 `t3.medium` 크기는 자동으로 올리지 않습니다. 한 서버부터 시작해 테스트 서버 수를 늘리면서 다음 명령으로 컨테이너 CPU·메모리를 기록하고, 같은 시간대 로그에서 audio underrun, OOM, engine encode 지연을 확인합니다. 지속 CPU가 80%를 넘거나 메모리 여유가 20% 아래로 내려가거나 underrun이 한 번이라도 발생하면 동시 세션 수를 제한한 뒤 `t3.large` 증설을 별도로 판단합니다.

```bash
free -m
docker stats --no-stream djscord-bot-1 djscord-engine-1 djscord-lavalink-1
docker compose --env-file /opt/djscord/.env -f /opt/djscord/compose.prod.yaml \
  logs --since=10m bot engine lavalink
```

CloudWatch의 `/djscord/prod/bot`, `/djscord/prod/engine`, `/djscord/prod/lavalink` 로그 그룹에서도 오류를 확인합니다.

## 운영 음원 준비

배포는 저작권이 있는 음원이나 Rekordbox XML을 생성·다운로드·삭제하지 않습니다. Session Manager로 접속해 운영자가 직접 아래 고정 경로를 준비해야 합니다.

```text
/opt/djengine/music/
/opt/djengine/config/rekordbox.xml
/opt/djengine/data/
```

`music`과 XML은 컨테이너에 읽기 전용으로 연결되며, 분석 DB가 들어가는 `data`만 djengine의 전용 UID 10001로 쓰기 가능합니다. 배포 스크립트는 root 권한 여부가 아니라 실제 컨테이너 UID 10001로 음악 폴더를 탐색하고 XML을 읽을 수 있는지 먼저 확인합니다. 파일이나 권한을 준비하지 않으면 기존 컨테이너를 바꾸기 전에 안전하게 중단됩니다.

음원과 XML을 처음 배치했거나 djengine 분석 규칙을 튜닝한 뒤에는 라이브러리를 다시 가져와야 합니다. 아래 명령은 엔진 컨테이너 안에서 import 작업을 시작하고 응답의 작업 ID를 `IMPORT_JOB_ID`에 저장합니다. `curl`은 HTTP 요청 도구이며, `-X POST`는 새 작업 생성, `Authorization` 헤더는 엔진 API 인증을 뜻합니다.

```bash
cd /opt/djscord
IMPORT_JOB_ID=$(docker compose --env-file .env -f compose.prod.yaml exec -T engine \
  sh -c 'curl -fsS -X POST http://127.0.0.1:8787/api/v1/libraries/default/imports \
    -H "Authorization: Bearer $DJENGINE_API_KEY"' \
  | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
test -n "$IMPORT_JOB_ID"
```

작업은 비동기로 실행됩니다. 즉 POST 응답 직후 분석이 끝난 것이 아니므로 `GET /api/v1/imports/$IMPORT_JOB_ID` 조회를 반복해 `status`가 `completed`인지 확인합니다. `analyzedTracks`는 실제 분석에 성공한 곡 수이고 DJ 믹스에는 분석된 곡이 최소 두 개 필요합니다. `failed`이거나 `analyzedTracks`가 2보다 작으면 `/디제이 시작` 전에 XML 경로와 음원 디코딩 오류를 고쳐 다시 import합니다.

```bash
docker compose --env-file .env -f compose.prod.yaml exec -T engine \
  sh -c 'curl -fsS http://127.0.0.1:8787/api/v1/imports/$1 \
    -H "Authorization: Bearer $DJENGINE_API_KEY"' sh "$IMPORT_JOB_ID"
```

마지막으로 import 응답의 `analyzedTracks`가 충분한지 확인한 뒤, 플레이리스트 API에서 실제로 사용할 플레이리스트를 찾습니다. `limit=100`은 한 번에 최대 100개를 조회한다는 뜻이며, 응답에 다음 페이지 cursor가 있으면 같은 API에 cursor를 추가해 계속 조회합니다.

```bash
docker compose --env-file .env -f compose.prod.yaml exec -T engine \
  sh -c 'curl -fsS "http://127.0.0.1:8787/api/v1/playlists?limit=100" \
    -H "Authorization: Bearer $DJENGINE_API_KEY"'
```

목록 응답에서 사용할 `id` 하나를 골라 아래 값에 넣습니다. 이 검증은 Node.js 봇 컨테이너에서 플레이리스트 상세 API를 호출하고, `analysisStatus`가 `ready`인 곡이 두 개 미만이면 exit code 1로 실패합니다. `fetch`는 Node.js 내장 HTTP 요청 함수이고 `Authorization` 헤더에는 봇 컨테이너에 주입된 엔진 API 키를 전달합니다.

```bash
PLAYLIST_ID=목록에서_고른_id
docker compose --env-file .env -f compose.prod.yaml exec -T bot \
  node --input-type=module -e '
    const playlistId = process.argv[1];
    const response = await fetch(
      `${process.env.DJENGINE_BASE_URL}/api/v1/playlists/${encodeURIComponent(playlistId)}`,
      { headers: { Authorization: `Bearer ${process.env.DJENGINE_API_KEY}` } }
    );
    if (!response.ok) throw new Error(`playlist request failed: ${response.status}`);
    const { data } = await response.json();
    const readyTracks = data.tracks.filter((track) => track.analysisStatus === "ready");
    console.log(`${data.name}: 분석 완료 ${readyTracks.length}/${data.tracks.length}곡`);
    if (readyTracks.length < 2) process.exit(1);
  ' "$PLAYLIST_ID"
```

## 8. 백업과 롤백

SQLite 온라인 백업을 만듭니다.

```bash
aws ssm start-session --target EC2_INSTANCE_ID
sudo /opt/djscord/deploy/backup-sqlite.sh
```

백업은 `/opt/djscord/data/backups/`에 생성됩니다. EBS 스냅샷도 별도로 매일 설정해야 합니다.

직전 정상 이미지로 되돌립니다.

```bash
sudo /opt/djscord/deploy/rollback.sh
```

DB 복원은 현재 DB를 `pre-restore-날짜.sqlite`로 한 번 더 보관한 뒤 진행합니다.

```bash
sudo /opt/djscord/deploy/restore-sqlite.sh djscord-백업날짜.sqlite
```

## 장애 확인 명령

Session Manager 터미널에서 사용합니다.

```bash
cd /opt/djscord
docker compose --env-file .env -f compose.prod.yaml ps
docker compose --env-file .env -f compose.prod.yaml logs --tail=200 bot engine lavalink
docker inspect --format '{{json .State.Health}}' djscord-bot-1
```

보안 그룹에 22번 SSH, Lavalink 2333번, djengine 8787번 포트를 추가하지 않습니다. Discord 봇과 상태 publisher가 서버에서 외부로 연결을 시작하므로 인바운드 포트가 필요하지 않습니다.
