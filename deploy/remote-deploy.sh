#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "사용법: $0 <게시된 Git 커밋 태그>" >&2
  exit 2
fi

image_tag=$1
case "$image_tag" in
  *[!0-9a-f]*|"") echo "이미지 태그는 Git 커밋 해시여야 합니다." >&2; exit 2 ;;
esac

stack_name=${STACK_NAME:-djscord-prod}
aws_region=${AWS_REGION:-ap-northeast-2}

stack_output() {
  aws cloudformation describe-stacks \
    --region "$aws_region" \
    --stack-name "$stack_name" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" \
    --output text
}

instance_id=$(stack_output InstanceId)
ecr_repository_uri=$(stack_output EcrRepositoryUri)
release_bucket=$(stack_output ReleaseBucketName)
bot_image="$ecr_repository_uri:$image_tag"
release_uri="s3://$release_bucket/releases/$image_tag.tar.gz"
archive_path="/tmp/djscord-$image_tag.tar.gz"
release_directory="/opt/djscord/releases/$image_tag"

command="set -eu; mkdir -p $release_directory; aws s3 cp $release_uri $archive_path --region $aws_region; tar -xzf $archive_path -C $release_directory; cp -R $release_directory/. /opt/djscord/; chmod 755 /opt/djscord/deploy/*.sh; AWS_REGION=$aws_region /opt/djscord/deploy/deploy.sh $bot_image; rm -f $archive_path"
parameters=$(printf '{"commands":["%s"]}' "$command")

command_id=$(aws ssm send-command \
  --region "$aws_region" \
  --instance-ids "$instance_id" \
  --document-name AWS-RunShellScript \
  --comment "djscord $image_tag 배포" \
  --parameters "$parameters" \
  --query Command.CommandId \
  --output text)

wait_status=0
aws ssm wait command-executed \
  --region "$aws_region" \
  --command-id "$command_id" \
  --instance-id "$instance_id" || wait_status=$?

aws ssm get-command-invocation \
  --region "$aws_region" \
  --command-id "$command_id" \
  --instance-id "$instance_id" \
  --query '{Status:Status,StandardOutput:StandardOutputContent,StandardError:StandardErrorContent}' \
  --output yaml

exit "$wait_status"
