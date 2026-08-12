#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(dirname "$script_dir")
stack_name=${STACK_NAME:-djscord-prod}
aws_region=${AWS_REGION:-ap-northeast-2}

command -v aws >/dev/null 2>&1 || { echo "aws CLI가 필요합니다." >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Docker가 필요합니다." >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "Git이 필요합니다." >&2; exit 1; }

cd "$project_root"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "커밋되지 않은 변경사항이 있어 릴리스를 만들 수 없습니다." >&2
  exit 1
fi

image_tag=$(git rev-parse --short=12 HEAD)
ecr_repository_uri=$(aws cloudformation describe-stacks \
  --region "$aws_region" \
  --stack-name "$stack_name" \
  --query "Stacks[0].Outputs[?OutputKey=='EcrRepositoryUri'].OutputValue | [0]" \
  --output text)
release_bucket=$(aws cloudformation describe-stacks \
  --region "$aws_region" \
  --stack-name "$stack_name" \
  --query "Stacks[0].Outputs[?OutputKey=='ReleaseBucketName'].OutputValue | [0]" \
  --output text)

if [ -z "$ecr_repository_uri" ] || [ "$ecr_repository_uri" = "None" ]; then
  echo "CloudFormation에서 ECR 저장소를 찾지 못했습니다." >&2
  exit 1
fi

registry=${ecr_repository_uri%%/*}
aws ecr get-login-password --region "$aws_region" \
  | docker login --username AWS --password-stdin "$registry" >/dev/null

temporary_directory=$(mktemp -d)
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM
source_directory="$temporary_directory/source"
mkdir -p "$source_directory"
git archive HEAD | tar -x -C "$source_directory"

bot_image="$ecr_repository_uri:$image_tag"
repository_name=${ecr_repository_uri#*/}
if aws ecr describe-images \
  --region "$aws_region" \
  --repository-name "$repository_name" \
  --image-ids imageTag="$image_tag" \
  >/dev/null 2>&1; then
  echo "이미 게시된 ECR 이미지를 재사용합니다: $bot_image"
else
  docker buildx build \
    --platform linux/amd64 \
    --target production \
    --tag "$bot_image" \
    --push \
    "$source_directory"
fi

bundle_directory="$temporary_directory/bundle"
mkdir -p "$bundle_directory/deploy" "$bundle_directory/lavalink"
cp "$source_directory/compose.prod.yaml" "$bundle_directory/compose.prod.yaml"
cp "$source_directory/lavalink/application.yml" "$bundle_directory/lavalink/application.yml"
cp "$source_directory/deploy/deploy.sh" "$bundle_directory/deploy/deploy.sh"
cp "$source_directory/deploy/render-env.sh" "$bundle_directory/deploy/render-env.sh"
cp "$source_directory/deploy/rollback.sh" "$bundle_directory/deploy/rollback.sh"
cp "$source_directory/deploy/backup-sqlite.sh" "$bundle_directory/deploy/backup-sqlite.sh"
cp "$source_directory/deploy/restore-sqlite.sh" "$bundle_directory/deploy/restore-sqlite.sh"

archive_path="$temporary_directory/djscord-$image_tag.tar.gz"
tar -C "$bundle_directory" -czf "$archive_path" compose.prod.yaml deploy lavalink
release_uri="s3://$release_bucket/releases/$image_tag.tar.gz"
aws s3 cp "$archive_path" "$release_uri" --region "$aws_region" >/dev/null

echo "릴리스를 게시했습니다."
echo "이미지: $bot_image"
echo "배포 묶음: $release_uri"
echo "다음 명령: $project_root/deploy/remote-deploy.sh $image_tag"
