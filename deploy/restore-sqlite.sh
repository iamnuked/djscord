#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "사용법: $0 <백업 파일명 또는 경로> [--yes]" >&2
  exit 2
fi

backup_input=$1
confirmed=${2:-}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_dir=$(dirname "$script_dir")
env_path="$app_dir/.env"
compose_file="$app_dir/compose.prod.yaml"
data_dir=${DATA_DIR:-/opt/djscord/data}
backup_dir="$data_dir/backups"
database_path="$data_dir/djscord.sqlite"

case "$backup_input" in
  /*) backup_path=$backup_input ;;
  *) backup_path="$backup_dir/$backup_input" ;;
esac

if [ ! -f "$backup_path" ]; then
  echo "백업 파일을 찾을 수 없습니다: $backup_path" >&2
  exit 1
fi

backup_root=$(realpath "$backup_dir")
resolved_backup=$(realpath "$backup_path")
case "$resolved_backup" in
  "$backup_root"/*) ;;
  *)
    echo "복원 파일은 $backup_root 아래에 있어야 합니다." >&2
    exit 1
    ;;
esac

if [ "$confirmed" != "--yes" ]; then
  printf '현재 DB를 교체합니다. 계속하려면 restore를 입력하세요: '
  read -r answer
  [ "$answer" = "restore" ] || { echo "복원을 취소했습니다."; exit 1; }
fi

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
cd "$app_dir"
docker compose --env-file "$env_path" -f "$compose_file" stop bot
restart_bot=1
trap 'if [ "$restart_bot" -eq 1 ]; then docker compose --env-file "$env_path" -f "$compose_file" up -d bot; fi' EXIT HUP INT TERM

if [ -f "$database_path" ]; then
  cp "$database_path" "$backup_dir/pre-restore-$timestamp.sqlite"
fi
install -m 600 -o 1000 -g 1000 "$resolved_backup" "$database_path"

docker compose --env-file "$env_path" -f "$compose_file" up -d bot
restart_bot=0
trap - EXIT HUP INT TERM
echo "SQLite 복원이 완료되었습니다: $resolved_backup"
