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

put_parameter DISCORD_TOKEN SecureString required
put_parameter DISCORD_CLIENT_ID String required
put_parameter KOFI_URL String optional
put_parameter LASTFM_API_KEY SecureString optional
put_parameter LAVALINK_PASSWORD SecureString required
