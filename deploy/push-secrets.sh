#!/bin/sh
set -eu

env_file=${1:-.env}
aws_region=${AWS_REGION:-ap-northeast-2}
parameter_path=${SSM_PARAMETER_PATH:-/djscord/prod}
parameter_path=${parameter_path%/}

if [ ! -f "$env_file" ]; then
  echo "환경 변수 파일을 찾을 수 없습니다: $env_file" >&2
  exit 1
fi

read_env_value() {
  key=$1
  sed -n "s/^${key}=//p" "$env_file" | tail -n 1
}

put_parameter() {
  key=$1
  type=$2
  required=$3
  value=$(read_env_value "$key")
  if [ -z "$value" ]; then
    if [ "$required" = "required" ]; then
      echo "$env_file 에 필수 값이 없습니다: $key" >&2
      exit 1
    fi
    echo "선택 값을 건너뜁니다: $key"
    return
  fi
  aws ssm put-parameter \
    --region "$aws_region" \
    --name "$parameter_path/$key" \
    --type "$type" \
    --value "$value" \
    --overwrite \
    >/dev/null
  echo "Parameter Store 값을 갱신했습니다: $parameter_path/$key"
}

mix_ingest_url=$(read_env_value MIX_INGEST_URL)
mix_ingest_secret=$(read_env_value MIX_INGEST_SECRET)
mix_public_url=$(read_env_value MIX_PUBLIC_URL)
if { [ -n "$mix_ingest_url" ] || [ -n "$mix_ingest_secret" ] || [ -n "$mix_public_url" ]; } &&
   { [ -z "$mix_ingest_url" ] || [ -z "$mix_ingest_secret" ] || [ -z "$mix_public_url" ]; }; then
  echo "MIX_INGEST_URL, MIX_INGEST_SECRET, MIX_PUBLIC_URL은 모두 함께 설정해야 합니다." >&2
  exit 1
fi

put_parameter DISCORD_TOKEN SecureString required
put_parameter DISCORD_CLIENT_ID String required
put_parameter KOFI_URL String optional
put_parameter LASTFM_API_KEY SecureString optional
put_parameter LAVALINK_PASSWORD SecureString required
put_parameter DJENGINE_API_KEY SecureString required
if [ -n "$mix_ingest_url" ]; then
  put_parameter MIX_INGEST_URL String required
  put_parameter MIX_INGEST_SECRET SecureString required
  put_parameter MIX_PUBLIC_URL String required
else
  aws ssm delete-parameters \
    --region "$aws_region" \
    --names \
      "$parameter_path/MIX_INGEST_URL" \
      "$parameter_path/MIX_INGEST_SECRET" \
      "$parameter_path/MIX_PUBLIC_URL" \
    >/dev/null
  echo "Mix publisher Parameter Store 값이 없어 비활성화했습니다."
fi
