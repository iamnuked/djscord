#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_dir=$(dirname "$script_dir")
env_path="$app_dir/.env"
compose_file="$app_dir/compose.prod.yaml"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_name="djscord-$timestamp.sqlite"
data_dir=${DATA_DIR:-/opt/djscord/data}

install -d -m 0750 -o 1000 -g 1000 "$data_dir/backups"
cd "$app_dir"
docker compose --env-file "$env_path" -f "$compose_file" exec -T bot \
  node --input-type=module -e '
    import { backup, DatabaseSync } from "node:sqlite";
    const source = "/data/djscord.sqlite";
    const destination = `/data/backups/${process.argv[1]}`;
    const database = new DatabaseSync(source, { timeout: 5_000 });
    await backup(database, destination);
    database.close();
  ' "$backup_name"

echo "SQLite 백업을 생성했습니다: $data_dir/backups/$backup_name"
