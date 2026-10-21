# AWS EC2 배포 가이드

이 문서는 서울 리전의 EC2 한 대에서 `bot`과 `lavalink` 컨테이너를 Docker Compose로 운영하는 절차입니다. 웹 서버가 아니므로 로드 밸런서, 도메인, HTTPS 인증서와 외부 인바운드 포트는 사용하지 않습니다.

## 구성 이해하기

- **CloudFormation**은 AWS 리소스 구성을 YAML 파일로 기록하고 같은 구성을 반복 생성하는 AWS 서비스입니다. `deploy/provision.sh`는 `aws cloudformation deploy` 명령으로 `infra/aws/djscord-ec2.yaml`을 적용합니다. `--stack-name`은 묶음 이름, `--parameter-overrides`는 템플릿에 VPC와 서브넷 값을 전달하는 옵션입니다.
- **ECR**은 비공개 Docker 이미지 저장소입니다. Mac에서 만든 봇 이미지를 저장하고 EC2가 실행할 이미지를 내려받습니다.
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
- `djscord/bot` ECR 저장소
- 비공개 S3 릴리스 버킷
- `/djscord/prod/bot`, `/djscord/prod/lavalink` CloudWatch 로그 그룹
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

선택 값:

- `KOFI_URL`
- `LASTFM_API_KEY`

선택 값을 로컬 `.env`에서 지우더라도 기존 Parameter Store 값은 자동 삭제되지 않습니다. 삭제가 필요하면 AWS 콘솔에서 해당 값만 직접 확인한 뒤 제거합니다.

## 5. 이미지와 릴리스 게시

모든 테스트를 먼저 실행합니다.

```bash
docker build --target test -t djscord-test .
```

테스트가 통과하면 현재 Git 커밋을 x86 EC2용 이미지로 만들고 ECR과 S3에 게시합니다.

```bash
./deploy/publish-release.sh
```

`docker buildx build`는 Mac의 ARM CPU와 다른 `linux/amd64` 이미지를 만들 수 있는 Docker 빌드 기능입니다. 게시 스크립트는 실제 아카이브 소스로 봇 TypeScript·unit·lint, 웹 lint·typecheck·unit·production build·SSR 검사를 먼저 실행합니다. 하나라도 실패하면 ECR push 전에 종료됩니다. 검증 후 `--platform linux/amd64`, 운영 단계인 `--target production`, ECR에 바로 업로드하는 `--push`를 사용합니다. 이미지는 `latest` 대신 Git 커밋 해시로 고정합니다.

출력 마지막에 다음과 같은 명령이 표시됩니다.

```bash
./deploy/remote-deploy.sh 12자리커밋해시
```

## 6. EC2에 원격 배포

로컬에서 실행 중인 같은 봇을 먼저 중지해 Discord 음성 연결 충돌을 막습니다.

```bash
docker compose down
```

게시 명령에서 출력된 태그로 배포합니다.

```bash
./deploy/remote-deploy.sh 12자리커밋해시
```

이 스크립트는 Systems Manager의 `AWS-RunShellScript` 문서로 다음 작업을 수행합니다.

1. S3 릴리스 파일 다운로드
2. Parameter Store로 `/opt/djscord/.env` 생성
3. ECR 이미지 다운로드
4. `docker compose up -d` 실행
5. Lavalink와 봇 상태가 `healthy`인지 최대 3분 동안 확인
6. 실행 결과와 오류를 로컬 터미널에 출력

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

CloudWatch의 `/djscord/prod/bot`과 `/djscord/prod/lavalink` 로그 그룹에서도 오류를 확인합니다.

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
docker compose --env-file .env -f compose.prod.yaml logs --tail=200 bot lavalink
docker inspect --format '{{json .State.Health}}' djscord-bot-1
```

보안 그룹에 22번 SSH나 Lavalink 2333번 포트를 추가하지 않습니다. Discord 봇과 Lavalink는 서버에서 외부로 연결을 시작하므로 인바운드 포트가 필요하지 않습니다.
