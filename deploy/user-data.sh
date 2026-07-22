#!/bin/bash
# EC2 user-data: install Docker + the compose plugin on first boot. The rest of
# the deploy (compose file, .env, `docker compose up -d`) is in docs/DEPLOY.md.
# Works on Ubuntu and Amazon Linux 2023.
set -euxo pipefail

curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

# Let the default login user run docker without sudo.
usermod -aG docker ubuntu 2>/dev/null || true
usermod -aG docker ec2-user 2>/dev/null || true

install -d -o root -g root /opt/prestidata
echo "Docker installed. Next: put docker-compose.prod.yml + .env in /opt/prestidata and run 'docker compose up -d'." > /opt/prestidata/README.txt
