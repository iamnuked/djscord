#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "사용법: $0 <ECR 이미지 URI:태그>" >&2
  exit 2
fi

bot_image=$1
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_dir=$(dirname "$script_dir")
env_path="$app_dir/.env"
compose_file="$app_dir/compose.prod.yaml"
deployed_image_file="$app_dir/.deployed-image"
previous_image_file="$app_dir/.previous-image"
aws_region=${AWS_REGION:-ap-northeast-2}

registry=${bot_image%%/*}
case "$registry" in
  *.dkr.ecr.*.amazonaws.com|*.dkr.ecr.*.amazonaws.com.cn) ;;
  *)
    echo "ECR 이미지 URI가 필요합니다: $bot_image" >&2
    exit 2
    ;;
esac

command -v aws >/dev/null 2>&1 || { echo "aws CLI가 필요합니다." >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Docker가 필요합니다." >&2; exit 1; }

install -d -m 0750 -o 1000 -g 1000 "${DATA_DIR:-/opt/djscord/data}"
"$script_dir/render-env.sh" "$bot_image" "$env_path"

aws ecr get-login-password --region "$aws_region" \
  | docker login --username AWS --password-stdin "$registry" >/dev/null

if [ -f "$deployed_image_file" ]; then
  current_image=$(sed -n '1p' "$deployed_image_file")
  if [ -n "$current_image" ] && [ "$current_image" != "$bot_image" ]; then
    printf '%s\n' "$current_image" > "$previous_image_file"
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

if ! wait_for_healthy_service lavalink || ! wait_for_healthy_service bot; then
  docker compose --env-file "$env_path" -f "$compose_file" ps >&2
  docker compose --env-file "$env_path" -f "$compose_file" logs --tail=100 bot lavalink >&2 || true
  echo "배포 검증에 실패했습니다. 이전 이미지가 있으면 deploy/rollback.sh를 실행하세요." >&2
  exit 1
fi

printf '%s\n' "$bot_image" > "$deployed_image_file"

if [ "${DEPLOY_COMMANDS:-0}" = "1" ]; then
  docker compose --env-file "$env_path" -f "$compose_file" run --rm bot \
    node dist/deploy-commands.js
fi

echo "배포가 완료되었습니다: $bot_image"
