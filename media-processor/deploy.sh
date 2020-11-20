#!/usr/bin/env bash

SERVICE=media-processor

#
# Check for required command line programs
#
for cmd in docker aws git; do
    if [[ -z "$(which ${cmd})" ]]; then
        echo "${cmd} is required to run this script."  >&2
        exit 1
    fi
done

#
# Don't deploy if the working directory is dirty
#
#if [[ ! -z "$(git status --porcelain)" ]]; then
#    echo "There are uncommitted changes in this git repo."  >&2
#    exit 1
#fi

# exit when any command fails
set -e

#
# Give docker access to our Amazon Container Registry
#
aws ecr get-login-password --region ap-northeast-2 | docker login --username AWS --password-stdin 603713662021.dkr.ecr.ap-northeast-2.amazonaws.com

#
# Mark the timestamp and commit hash
#
echo "{\"commit\":\"`git rev-parse HEAD`\", \"timestamp\": \"`date -u`\", \"service\": \"$SERVICE\"}" > deploy.json

#
# Build a docker image from the current working directory
#
docker build . --tag 603713662021.dkr.ecr.ap-northeast-2.amazonaws.com/$SERVICE:latest

#
# Push the image to the container registry
#
docker push 603713662021.dkr.ecr.ap-northeast-2.amazonaws.com/$SERVICE:latest

#
# Instruct our AWS ECS service to redeploy, using the latest ECS image
#
aws ecs update-service --service $SERVICE --cluster hilokal --force-new-deployment > /dev/null

echo "Deployment finished. It may take a few minutes for the new deployment to come online"
