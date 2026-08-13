#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_dir=$(dirname "$script_dir")
previous_image_file="$app_dir/.previous-images"

if [ ! -s "$previous_image_file" ]; then
  echo "롤백할 이전 이미지 기록이 없습니다." >&2
  exit 1
fi

previous_image=$(sed -n '1p' "$previous_image_file")
previous_engine_image=$(sed -n '2p' "$previous_image_file")
if [ -z "$previous_image" ] || [ -z "$previous_engine_image" ]; then
  echo "롤백할 봇/엔진 이미지 기록이 완전하지 않습니다." >&2
  exit 1
fi
echo "이전 봇/엔진 이미지로 롤백합니다."
"$script_dir/deploy.sh" "$previous_image" "$previous_engine_image"
