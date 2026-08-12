#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "사용법: $0 <VPC ID> <퍼블릭 Subnet ID>" >&2
  exit 2
fi

vpc_id=$1
subnet_id=$2
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(dirname "$script_dir")
stack_name=${STACK_NAME:-djscord-prod}
aws_region=${AWS_REGION:-ap-northeast-2}

case "$vpc_id" in vpc-[A-Za-z0-9]*) ;; *) echo "VPC ID 형식이 올바르지 않습니다." >&2; exit 2 ;; esac
case "$subnet_id" in subnet-[A-Za-z0-9]*) ;; *) echo "Subnet ID 형식이 올바르지 않습니다." >&2; exit 2 ;; esac

aws cloudformation deploy \
  --region "$aws_region" \
  --stack-name "$stack_name" \
  --template-file "$project_root/infra/aws/djscord-ec2.yaml" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides VpcId="$vpc_id" SubnetId="$subnet_id" \
  --no-fail-on-empty-changeset

aws cloudformation describe-stacks \
  --region "$aws_region" \
  --stack-name "$stack_name" \
  --query 'Stacks[0].Outputs[].{Key:OutputKey,Value:OutputValue}' \
  --output table
