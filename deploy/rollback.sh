#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_dir=$(dirname "$script_dir")
previous_image_file="$app_dir/.previous-image"

if [ ! -s "$previous_image_file" ]; then
  echo "롤백할 이전 이미지 기록이 없습니다." >&2
  exit 1
fi

previous_image=$(sed -n '1p' "$previous_image_file")
echo "이전 이미지로 롤백합니다: $previous_image"
"$script_dir/deploy.sh" "$previous_image"
