#!/usr/bin/env bash
# Nightly Postgres dump -> S3. Installed and scheduled by box-setup.sh.
#
# Runs on the host (not in a container) so it can talk to both docker and S3.
# The AWS CLI isn't installed on the box, so S3 access goes through the official
# aws-cli image — the instance role reaches IMDS from a container because the
# hop limit is 2 (see terraform/compute.tf).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/prestidata}"
COMPOSE="$APP_DIR/docker-compose.prod.yml"
cd "$APP_DIR"

# Read .env literally, the way docker compose does — do NOT `.`-source it.
# Compose accepts unquoted values containing spaces (DOMAIN=abracadata.me
# www.abracadata.me is a legitimate two-host Caddy site block), but sourcing
# that in a shell tries to *run* `www.abracadata.me` and the backup dies at
# line 1 with "command not found".
env_get() {
  local v
  v="$(sed -n "s/^$1=//p" "$APP_DIR/.env" | tail -1)"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

POSTGRES_USER="$(env_get POSTGRES_USER)"
POSTGRES_DB="$(env_get POSTGRES_DB)"
MAIL_FROM="$(env_get MAIL_FROM)"
ALERT_EMAIL="$(env_get ALERT_EMAIL)"
REGION="$(env_get AWS_REGION)"; REGION="${REGION:-us-east-2}"
BUCKET="$(env_get BACKUP_BUCKET)"

: "${POSTGRES_USER:?POSTGRES_USER missing from $APP_DIR/.env}"
: "${POSTGRES_DB:?POSTGRES_DB missing from $APP_DIR/.env}"
: "${BUCKET:?BACKUP_BUCKET must be set in $APP_DIR/.env}"

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
KEY="postgres/${POSTGRES_DB}-${STAMP}.sql.gz"
TMP="$(mktemp /tmp/pgdump-XXXXXX.sql.gz)"
trap 'rm -f "$TMP"' EXIT

fail() {
  echo "backup FAILED: $*" >&2
  # A backup that quietly stops working is worse than none, because you believe
  # you're covered. Best-effort alert; never let it mask the original failure.
  if [ -n "$MAIL_FROM" ] && [ -n "$ALERT_EMAIL" ]; then
    docker run --rm -e AWS_REGION="$REGION" amazon/aws-cli:latest sesv2 send-email \
      --from-email-address "$MAIL_FROM" \
      --destination "ToAddresses=$ALERT_EMAIL" \
      --content "Simple={Subject={Data=Abracadata: nightly backup FAILED,Charset=UTF-8},Body={Text={Data=$* ,Charset=UTF-8}}}" \
      >/dev/null 2>&1 || true
  fi
  exit 1
}

echo "==> dumping $POSTGRES_DB"
docker compose -f "$COMPOSE" exec -T postgres \
  pg_dump -U "$POSTGRES_USER" --clean --if-exists "$POSTGRES_DB" | gzip -9 > "$TMP" \
  || fail "pg_dump failed"

# A truncated or empty dump uploads happily and restores to nothing, so check
# the archive is intact and plausibly sized before trusting it.
gzip -t "$TMP" || fail "dump is not a valid gzip archive"
SIZE=$(stat -c%s "$TMP")
[ "$SIZE" -ge 1000 ] || fail "dump suspiciously small (${SIZE} bytes)"
zcat "$TMP" | grep -q "CREATE TABLE" || fail "dump contains no CREATE TABLE statements"

echo "==> uploading s3://$BUCKET/$KEY (${SIZE} bytes)"
docker run --rm -e AWS_REGION="$REGION" -v "$TMP:/dump.sql.gz:ro" \
  amazon/aws-cli:latest s3 cp /dump.sql.gz "s3://$BUCKET/$KEY" \
  || fail "upload to s3://$BUCKET/$KEY failed"

echo "==> backup complete: s3://$BUCKET/$KEY"
