# Deploying Prestidata (POC, single EC2 box)

A deliberately cheap POC: **one small EC2 instance** running Docker Compose —
Caddy (auto-HTTPS + static + `/api` proxy), the FastAPI backend, and Postgres —
with images built in **CI (GHCR)** and pulled by the box. No ECS/ALB/RDS.

Why it's so cheap: the heavy work (Pyodide/pandas) runs in the **browser**, and
file data never touches the server. The box is a thin API proxy + static host +
small DB. Est. **~$8–15/mo** infra + Bedrock per-token usage.

```
Internet ─HTTPS─▶ Caddy ── /            → static SPA + prerendered SEO pages
                        └─ /api/*        → backend:8000 (FastAPI)
                    backend ── boto3 ──▶ Bedrock  (via EC2 instance role, no keys)
                    postgres (container, pgdata volume)
```

Decisions baked in (all one flag to change later):
- **Auth: anonymous-only.** The web image is built with `VITE_AUTH_ENABLED=false`
  so "Sign in" is hidden (passwordless sign-in needs SES first). Flip the build
  arg in `deploy/web.Dockerfile` when SES is wired.
- **DB: Postgres container** on a volume. Same dialect as RDS, so migrating later
  is just a `DATABASE_URL` change + a `pg_dump | pg_restore`.

---

## 1. One-time: CI → GHCR

1. Create the GitHub repo and push this code. The workflow `.github/workflows/deploy.yml`
   builds `prestidata-web` and `prestidata-backend` and pushes them to
   `ghcr.io/<owner>/…` on every push to `main` (and via *Run workflow*).
2. After the first run, open **repo → Packages** and set both packages to
   **Public** (simplest — the box then pulls with no auth). If you keep them
   private, create a read-only PAT and `docker login ghcr.io` on the box.

## 2. One-time: AWS

**Instance role for Bedrock** (no static keys on the box):
```sh
aws iam create-role --role-name prestidata-ec2 \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam put-role-policy --role-name prestidata-ec2 \
  --policy-name bedrock-invoke --policy-document file://deploy/bedrock-instance-policy.json
aws iam create-instance-profile --instance-profile-name prestidata-ec2
aws iam add-role-to-instance-profile --instance-profile-name prestidata-ec2 --role-name prestidata-ec2
```
Also allow SSM (for keyless shell): attach the managed policy
`AmazonSSMManagedInstanceCore` to `prestidata-ec2` too.

**Launch the instance** — `t4g.small` (2 GB, ARM; or `t4g.micro` 1 GB since we
only *pull* images), Ubuntu 24.04 or AL2023, 20 GB gp3:
```sh
aws ec2 run-instances \
  --image-id <ubuntu-or-al2023-arm64-ami> --instance-type t4g.small \
  --iam-instance-profile Name=prestidata-ec2 \
  --metadata-options "HttpTokens=required,HttpPutResponseHopLimit=2" \
  --user-data file://deploy/user-data.sh \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":20,"VolumeType":"gp3"}}]' \
  --security-group-ids <sg-with-80-443-open> \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=prestidata}]'
```
- **`HttpPutResponseHopLimit=2` is required** — otherwise containers can't reach
  the instance-metadata endpoint and Bedrock calls fail with "no credentials".
- Security group: inbound **80 + 443** from `0.0.0.0/0`. No SSH — use SSM.
- Allocate an **Elastic IP** and associate it (stable IP for DNS).

**DNS:** point `prestidata.app` (A record) at the Elastic IP (Route 53 or your
registrar). Caddy needs this + port 80 reachable to issue the cert.

## 3. Bring it up on the box

Shell in with SSM: `aws ssm start-session --target <instance-id>`, then:
```sh
sudo install -d /opt/prestidata && cd /opt/prestidata
# copy these two files up (scp via SSM, or curl from your repo once public):
#   deploy/docker-compose.prod.yml  ->  docker-compose.prod.yml
#   deploy/.env.example             ->  .env   (then edit)
sudo nano .env      # set IMAGE_REPO, DOMAIN, ACME_EMAIL, POSTGRES_PASSWORD
sudo docker compose -f docker-compose.prod.yml up -d
sudo docker compose -f docker-compose.prod.yml logs -f web   # watch cert issuance
```
Visit `https://prestidata.app`. Verify Bedrock via the app (generate a recipe)
or: `sudo docker compose -f docker-compose.prod.yml exec backend curl -s localhost:8000/health`.

## 4. Deploying updates

CI pushes new images on merge to `main`. Then on the box:
```sh
sudo bash /opt/prestidata/update.sh    # pull + up -d + prune
```
(Optionally automate later with an SSM `SendCommand` step in CI, or a webhook.)

## 5. Backups

`pgdata` lives on the EBS volume. For a POC, a nightly logical dump to S3:
```sh
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U prestidata prestidata | gzip | aws s3 cp - s3://<bucket>/prestidata/$(date +%F).sql.gz
```
(Put that in a cron/systemd-timer.) Or snapshot the EBS volume.

## Later: production hardening

- **SES for sign-in:** verify a sender, request prod access, implement `_send_code`
  in `backend/app/auth.py`, then rebuild the web image with `VITE_AUTH_ENABLED=true`.
- **RDS:** create a Postgres instance, `pg_dump | pg_restore`, drop the `postgres`
  service, and point `DATABASE_URL` at RDS. Nothing else changes.
- **Auto-deploy, healthchecks/alerts, a second AZ** — when it's more than a POC.

## Local dev is unchanged

Dev stays on your machine: `make -C backend dev-local` + `make -C frontend dev-local`
(or the existing root `docker-compose.yml`). No dev instance in AWS.
