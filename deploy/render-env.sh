#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
  echo "사용법: $0 <봇 ECR 이미지 URI:태그> <엔진 ECR 이미지 URI:태그> <출력 .env 경로>" >&2
  exit 2
fi

bot_image=$1
engine_image=$2
output_path=$3
aws_region=${AWS_REGION:-ap-northeast-2}
parameter_path=${SSM_PARAMETER_PATH:-/djscord/prod}
data_dir=${DATA_DIR:-/opt/djscord/data}
parameter_path=${parameter_path%/}

case "$bot_image" in
  *[!A-Za-z0-9._:/@-]*|"")
    echo "BOT_IMAGE 형식이 올바르지 않습니다." >&2
    exit 2
    ;;
esac
case "$engine_image" in
  *[!A-Za-z0-9._:/@-]*|"")
    echo "DJENGINE_IMAGE 형식이 올바르지 않습니다." >&2
    exit 2
    ;;
esac

umask 077
temporary_path=$(mktemp "${output_path}.tmp.XXXXXX")
trap 'rm -f "$temporary_path"' EXIT HUP INT TERM

write_value() {
  key=$1
  value=$2
  case "$value" in
    *'
'*)
      echo "$key 값에는 줄바꿈을 넣을 수 없습니다." >&2
      exit 1
      ;;
  esac
  escaped_value=$(printf '%s' "$value" | sed "s/'/\\\\'/g")
  # Compose dotenv의 single quote는 $, ${...}, 공백을 다시 해석하지 않고
  # literal 값으로 전달합니다. 내부 single quote만 \'로 escape합니다.
  printf "%s='%s'\n" "$key" "$escaped_value" >> "$temporary_path"
}

get_parameter() {
  aws ssm get-parameter \
    --region "$aws_region" \
    --name "$parameter_path/$1" \
    --with-decryption \
    --query Parameter.Value \
    --output text
}

write_required_parameter() {
  key=$1
  if ! value=$(get_parameter "$key"); then
    echo "필수 Parameter Store 값이 없습니다: $parameter_path/$key" >&2
    exit 1
  fi
  if [ -z "$value" ] || [ "$value" = "None" ]; then
    echo "필수 Parameter Store 값이 비어 있습니다: $parameter_path/$key" >&2
    exit 1
  fi
  write_value "$key" "$value"
}

write_optional_parameter() {
  key=$1
  if value=$(get_parameter "$key" 2>/dev/null) && [ -n "$value" ] && [ "$value" != "None" ]; then
    write_value "$key" "$value"
  fi
}

optional_parameter_value() {
  key=$1
  value=$(get_parameter "$key" 2>/dev/null) || return 1
  if [ -z "$value" ] || [ "$value" = "None" ]; then
    return 1
  fi
  printf '%s' "$value"
}

write_value BOT_IMAGE "$bot_image"
write_value DJENGINE_IMAGE "$engine_image"
write_value AWS_REGION "$aws_region"
write_value DATA_DIR "$data_dir"
write_value DATABASE_PATH /data/djscord.sqlite
write_required_parameter DISCORD_TOKEN
write_required_parameter DISCORD_CLIENT_ID
write_optional_parameter KOFI_URL
write_optional_parameter LASTFM_API_KEY
write_value LAVALINK_HOST lavalink
write_value LAVALINK_PORT 2333
write_required_parameter LAVALINK_PASSWORD
write_required_parameter DJENGINE_API_KEY
write_value DJENGINE_BASE_URL http://engine:8787
write_value DJENGINE_DATA_DIR /opt/djengine/data
write_value DJENGINE_HOST_MUSIC_ROOT /opt/djengine/music
write_value DJENGINE_HOST_REKORDBOX_XML /opt/djengine/config/rekordbox.xml
mix_ingest_url=$(optional_parameter_value MIX_INGEST_URL || true)
mix_ingest_secret=$(optional_parameter_value MIX_INGEST_SECRET || true)
mix_public_url=$(optional_parameter_value MIX_PUBLIC_URL || true)
if { [ -n "$mix_ingest_url" ] || [ -n "$mix_ingest_secret" ] || [ -n "$mix_public_url" ]; } &&
   { [ -z "$mix_ingest_url" ] || [ -z "$mix_ingest_secret" ] || [ -z "$mix_public_url" ]; }; then
  echo "MIX_INGEST_URL, MIX_INGEST_SECRET, MIX_PUBLIC_URL은 모두 함께 설정해야 합니다." >&2
  exit 1
fi
if [ -n "$mix_ingest_url" ]; then
  write_value MIX_INGEST_URL "$mix_ingest_url"
  write_value MIX_INGEST_SECRET "$mix_ingest_secret"
  write_value MIX_PUBLIC_URL "$mix_public_url"
fi

chmod 600 "$temporary_path"
mv "$temporary_path" "$output_path"
trap - EXIT HUP INT TERM
echo "환경 변수 파일을 안전하게 갱신했습니다: $output_path"
