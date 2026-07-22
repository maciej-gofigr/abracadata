#!/bin/bash
# Deploy the latest images. Run on the box (via SSM/ssh) after CI has pushed:
#   ssm> sudo bash /opt/prestidata/update.sh
set -euo pipefail
cd /opt/prestidata
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker image prune -f
docker compose -f docker-compose.prod.yml ps
