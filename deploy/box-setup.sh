#!/usr/bin/env bash
# Deploy (or update) Abracadata on the box. Idempotent — safe to re-run.
# Terraform provisions the box and installs Docker; THIS runs the app on it.
#
# Run over SSM (`aws ssm start-session --target <id>`) or SSH, then:
#   sudo bash -c 'curl -fsSL https://raw.githubusercontent.com/maciej-gofigr/abracadata/main/deploy/box-setup.sh | bash'
# or copy this file up and: sudo bash box-setup.sh
#
# Overridable via env: REPO, IMAGE_REPO, APP_DIR, AWS_REGION.
set -euo pipefail

REPO="${REPO:-maciej-gofigr/abracadata}"
RAW="https://raw.githubusercontent.com/${REPO}/main"
APP_DIR="${APP_DIR:-/opt/prestidata}"
IMAGE_REPO="${IMAGE_REPO:-ghcr.io/${REPO%%/*}}"   # e.g. ghcr.io/maciej-gofigr
COMPOSE="docker-compose.prod.yml"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found — the instance user-data should have installed it. Wait for cloud-init to finish, then re-run." >&2
  exit 1
fi

install -d "$APP_DIR"
cd "$APP_DIR"

# Compose file: always refreshed from the repo (it's the source of truth).
echo "Fetching $COMPOSE from $REPO…"
curl -fsSL "$RAW/deploy/$COMPOSE" -o "$COMPOSE"

# .env: seed once with a generated DB password; never clobber an existing one.
if [[ ! -f .env ]]; then
  echo "No .env — generating one (DB password randomized; DOMAIN blank = plain HTTP)…"
  cat > .env <<EOF
IMAGE_REPO=${IMAGE_REPO}
IMAGE_TAG=latest
# Leave DOMAIN blank for plain HTTP on the box IP; set a hostname for auto-HTTPS.
DOMAIN=
ACME_EMAIL=
POSTGRES_USER=prestidata
POSTGRES_PASSWORD=$(openssl rand -hex 24)
POSTGRES_DB=prestidata
AWS_REGION=${AWS_REGION:-us-east-2}
BEDROCK_MODEL=global.anthropic.claude-sonnet-4-6
SUGGEST_MODEL=global.anthropic.claude-haiku-4-5-20251001-v1:0
EOF
  chmod 600 .env
else
  echo "Keeping existing .env."
fi

echo "Pulling images and starting…"
docker compose -f "$COMPOSE" pull
docker compose -f "$COMPOSE" up -d
docker compose -f "$COMPOSE" ps

cat <<EOF

Done. If DOMAIN is blank, the app is at  http://<this-box-ip>/
Set DOMAIN in $APP_DIR/.env and re-run this script once DNS points here (auto-HTTPS).
EOF
