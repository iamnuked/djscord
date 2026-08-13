#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "사용법: $0 <봇 ECR 이미지 URI:태그> <엔진 ECR 이미지 URI:태그>" >&2
  exit 2
fi

bot_image=$1
engine_image=$2
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_dir=$(dirname "$script_dir")
env_path="$app_dir/.env"
compose_file="$app_dir/compose.prod.yaml"
deployed_image_file="$app_dir/.deployed-images"
previous_image_file="$app_dir/.previous-images"
legacy_deployed_image_file="$app_dir/.deployed-image"
aws_region=${AWS_REGION:-ap-northeast-2}

registry=${bot_image%%/*}
case "$registry" in
  *.dkr.ecr.*.amazonaws.com|*.dkr.ecr.*.amazonaws.com.cn) ;;
  *)
    echo "ECR 이미지 URI가 필요합니다: $bot_image" >&2
    exit 2
    ;;
esac
engine_registry=${engine_image%%/*}
case "$engine_registry" in
  *.dkr.ecr.*.amazonaws.com|*.dkr.ecr.*.amazonaws.com.cn) ;;
  *)
    echo "djengine ECR 이미지 URI가 필요합니다: $engine_image" >&2
    exit 2
    ;;
esac

command -v aws >/dev/null 2>&1 || { echo "aws CLI가 필요합니다." >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Docker가 필요합니다." >&2; exit 1; }
command -v setpriv >/dev/null 2>&1 || { echo "setpriv 명령이 필요합니다." >&2; exit 1; }

music_root=${DJENGINE_HOST_MUSIC_ROOT:-/opt/djengine/music}
rekordbox_xml=${DJENGINE_HOST_REKORDBOX_XML:-/opt/djengine/config/rekordbox.xml}
engine_data_dir=${DJENGINE_DATA_DIR:-/opt/djengine/data}

assert_engine_inputs_readable() {
  input_music_root=$1
  input_rekordbox_xml=$2
  if [ ! -d "$input_music_root" ] || [ ! -f "$input_rekordbox_xml" ]; then
    echo "DJ Engine 음악 폴더 또는 Rekordbox XML이 없습니다: $input_music_root / $input_rekordbox_xml" >&2
    return 1
  fi
  if ! setpriv --reuid 10001 --regid 10001 --clear-groups \
    sh -c 'test -r "$1" && test -x "$1" && test -r "$2"' \
    sh "$input_music_root" "$input_rekordbox_xml"; then
    echo "DJ Engine UID 10001이 음악 폴더 또는 Rekordbox XML을 읽을 수 없습니다: $input_music_root / $input_rekordbox_xml" >&2
    return 1
  fi
}

# 운영자가 준비한 음원과 XML은 어떤 디렉터리 생성이나 컨테이너 교체보다 먼저 검증합니다.
assert_engine_inputs_readable "$music_root" "$rekordbox_xml"

install -d -m 0750 -o 1000 -g 1000 "${DATA_DIR:-/opt/djscord/data}"
install -d -m 0750 -o 10001 -g 10001 "$engine_data_dir"
"$script_dir/render-env.sh" "$bot_image" "$engine_image" "$env_path"

aws ecr get-login-password --region "$aws_region" \
  | docker login --username AWS --password-stdin "$registry" >/dev/null
if [ "$engine_registry" != "$registry" ]; then
  aws ecr get-login-password --region "$aws_region" \
    | docker login --username AWS --password-stdin "$engine_registry" >/dev/null
fi

if [ -f "$deployed_image_file" ]; then
  current_bot_image=$(sed -n '1p' "$deployed_image_file")
  current_engine_image=$(sed -n '2p' "$deployed_image_file")
  if [ -n "$current_bot_image" ] && [ -n "$current_engine_image" ] &&
     { [ "$current_bot_image" != "$bot_image" ] || [ "$current_engine_image" != "$engine_image" ]; }; then
    printf '%s\n%s\n' "$current_bot_image" "$current_engine_image" > "$previous_image_file"
  fi
elif [ -s "$legacy_deployed_image_file" ]; then
  legacy_bot_image=$(sed -n '1p' "$legacy_deployed_image_file")
  if [ -n "$legacy_bot_image" ] && [ "$legacy_bot_image" != "$bot_image" ]; then
    # 이전 배포에는 엔진 이미지 기록이 없으므로 새 엔진을 유지한 채 봇만 되돌릴 수 있게 합니다.
    printf '%s\n%s\n' "$legacy_bot_image" "$engine_image" > "$previous_image_file"
  fi
fi

cd "$app_dir"
docker compose --env-file "$env_path" -f "$compose_file" pull
docker compose --env-file "$env_path" -f "$compose_file" up -d --remove-orphans

wait_for_healthy_service() {
  service=$1
  attempts=0
  while [ "$attempts" -lt 36 ]; do
    container_id=$(docker compose --env-file "$env_path" -f "$compose_file" ps -q "$service")
    if [ -n "$container_id" ]; then
      status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")
      case "$status" in
        healthy|running) return 0 ;;
        exited|dead|unhealthy)
          echo "$service 컨테이너 상태가 $status 입니다." >&2
          return 1
          ;;
      esac
    fi
    attempts=$((attempts + 1))
    sleep 5
  done
  echo "$service 컨테이너가 제한 시간 안에 정상 상태가 되지 않았습니다." >&2
  return 1
}

if ! wait_for_healthy_service engine || ! wait_for_healthy_service lavalink || ! wait_for_healthy_service bot; then
  docker compose --env-file "$env_path" -f "$compose_file" ps >&2
  docker compose --env-file "$env_path" -f "$compose_file" logs --tail=100 bot engine lavalink >&2 || true
  echo "배포 검증에 실패했습니다. 이전 이미지가 있으면 deploy/rollback.sh를 실행하세요." >&2
  exit 1
fi

printf '%s\n%s\n' "$bot_image" "$engine_image" > "$deployed_image_file"

if [ "${DEPLOY_COMMANDS:-0}" = "1" ]; then
  docker compose --env-file "$env_path" -f "$compose_file" run --rm bot \
    node dist/deploy-commands.js
fi

echo "배포가 완료되었습니다: $bot_image / $engine_image"
