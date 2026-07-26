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

## 2. Provision AWS (Terraform)

The `terraform/` dir stands up everything: the instance role (Bedrock + SSM, no
static keys), a security group (80/443 open, SSH closed by default), an ARM
EC2 box (Ubuntu 24.04, Docker installed via `deploy/user-data.sh`, IMDSv2 with
**hop limit 2**), and an Elastic IP. State is local — fine for a POC.

```sh
cd terraform
cp terraform.tfvars.example terraform.tfvars   # optional — defaults work as-is
terraform init
terraform apply
```
Needs AWS creds in your shell (`AWS_PROFILE=… aws sso login`, or env keys) for a
region where your Bedrock models are enabled (default `us-east-2`). Outputs:
`public_ip` (for DNS later), `ssm_command`, `app_url_http`, and `bring_up` (the
exact command for step 3).

- **Hop limit 2 is baked in** — without it, containers can't reach the metadata
  endpoint and Bedrock calls fail with "no credentials".
- **Access is SSM-only by default** (no open port 22). To use SSH instead, set
  `key_name` + `ssh_ingress_cidr` (your IP only) in `terraform.tfvars`.

**DNS (when you have a domain):** point an A record at the `public_ip` output.
Caddy needs this + port 80 reachable to issue the cert.

> **No domain yet?** That's the default — `DOMAIN` starts blank, so Caddy serves
> plain **HTTP on the box's raw IP** (site address falls back to `:80`, no cert).
> Smoke-test at the `app_url_http` output. Anonymous sessions work over HTTP (the
> session cookie isn't `Secure`-only). Later, set `DOMAIN` in the box's `.env` and
> re-run step 3 — Caddy provisions the cert on the next request. (443 is already
> open, so no infra change needed then.)

## 3. Bring it up on the box

Open a keyless shell with the `ssm_command` output, then run the `bring_up`
command (also printed by Terraform):
```sh
aws ssm start-session --target <instance-id>          # = ssm_command output
sudo bash -c 'curl -fsSL https://raw.githubusercontent.com/maciej-gofigr/prestidata/main/deploy/box-setup.sh | bash'
```
`deploy/box-setup.sh` is idempotent: it fetches `docker-compose.prod.yml`, seeds
`/opt/prestidata/.env` on first run (random DB password, `DOMAIN` blank, correct
`IMAGE_REPO`), then `docker compose pull && up -d`. Re-run it any time to update
or after editing `.env`. (If cloud-init hasn't finished installing Docker yet,
it'll tell you to wait and re-run.)

Visit the `app_url_http` URL. Verify Bedrock by generating a recipe, or:
`sudo docker compose -f /opt/prestidata/docker-compose.prod.yml exec backend curl -s localhost:8000/health`.

## 4. Deploying updates

CI pushes new images on merge to `main`. Then on the box, just re-run the
bring-up script (or the lighter `update.sh`):
```sh
sudo bash -c 'curl -fsSL https://raw.githubusercontent.com/maciej-gofigr/prestidata/main/deploy/box-setup.sh | bash'
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
