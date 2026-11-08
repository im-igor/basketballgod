#!/usr/bin/env bash
# Deploy the version already published to GitHub main. Run this on bbgod-app.
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/home/yc-user/basketballgod}"
BRANCH="${BRANCH:-main}"

cd "$APP_DIR"

if [[ ! -d .git ]]; then
  echo "Git is not initialized in $APP_DIR" >&2
  exit 1
fi

# Server-specific .env, secrets/ and docker-compose.local.yml are ignored by Git.
# Only tracked-file edits block a deploy, preventing an accidental overwrite.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Tracked files have local changes; commit or discard them before deploying." >&2
  git status --short >&2
  exit 1
fi

git fetch --prune origin "$BRANCH"
git checkout "$BRANCH"
BEFORE="$(git rev-parse --short HEAD)"
git pull --ff-only origin "$BRANCH"
AFTER="$(git rev-parse --short HEAD)"

echo "Deploying $BEFORE -> $AFTER"
docker compose -f docker-compose.yml -f docker-compose.local.yml build app
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --no-deps app
docker compose -f docker-compose.yml -f docker-compose.local.yml ps --format '{{.Name}} {{.State}}'

for attempt in {1..30}; do
  if health="$(curl --fail --silent --max-time 3 http://127.0.0.1:3000/healthz)"; then
    echo "Healthcheck: $health"
    break
  fi

  if [[ "$attempt" == 30 ]]; then
    echo "Application did not become healthy within 30 seconds." >&2
    exit 1
  fi

  sleep 1
done

echo "Deployment completed at $AFTER"
