# Deploying Abracadata (POC, single EC2 box)

A deliberately cheap POC: **one small EC2 instance** running Docker Compose —
Caddy (auto-HTTPS + static + `/api` proxy), the FastAPI backend, and Postgres —
with images built in **CI (GHCR)** and pulled by the box. No ECS/ALB/RDS.

Why it's so cheap: the recipe engine (Arquero/JS) runs entirely in the
**browser**, and file data never touches the server. The box is a thin API proxy + static host +
small DB. Est. **~$8–15/mo** infra + Bedrock per-token usage.

```
Internet ─HTTPS─▶ Caddy ── /            → static SPA + prerendered SEO pages
                        └─ /api/*        → backend:8000 (FastAPI)
                    backend ── boto3 ──▶ Bedrock  (via EC2 instance role, no keys)
                    postgres (container, pgdata volume)
```

Decisions baked in (all one flag to change later):
- **Auth: sign-in enabled, and required to save.** The app is fully usable signed
  out (drop files, generate, run, download); saving to the library requires a
  free account, which is also the sign-up funnel. Passwordless via SES (§6). Set `VITE_AUTH_ENABLED=false` in `deploy/web.Dockerfile` to hide the
  sign-in UI again.
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
sudo bash -c 'curl -fsSL https://raw.githubusercontent.com/maciej-gofigr/abracadata/main/deploy/box-setup.sh | bash'
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
sudo bash -c 'curl -fsSL https://raw.githubusercontent.com/maciej-gofigr/abracadata/main/deploy/box-setup.sh | bash'
```
(Optionally automate later with an SSM `SendCommand` step in CI, or a webhook.)

## 5. Backups

`pgdata` lives on the box's root EBS volume, which is `delete_on_termination` —
so losing the instance loses every account, saved recipe and setting. A nightly
dump to S3 is the copy that makes that survivable.

**It runs automatically.** `deploy/backup.sh` plus a systemd timer (03:17 UTC,
`Persistent=true`, so a box that was off still runs once it's back) are installed
and refreshed by `box-setup.sh` on every deploy. Terraform creates the bucket
(versioned, encrypted, public access blocked, 30-day expiry) and grants the
instance role access; `terraform output backup_bucket` gives its name, which must
be set as `BACKUP_BUCKET` in `/opt/prestidata/.env`. Set `ALERT_EMAIL` too — the
script emails on failure, because a backup that silently stops is worse than none.

Check on it:
```sh
systemctl list-timers abracadata-backup.timer      # when it next runs
journalctl -u abracadata-backup.service -n 20      # how the last run went
aws s3 ls s3://$(terraform -chdir=terraform output -raw backup_bucket)/postgres/
```

### Restoring

Verify a dump by restoring it somewhere disposable *before* you need it:
```sh
aws s3 cp s3://<bucket>/postgres/<file>.sql.gz .
docker run -d --name pgtest -e POSTGRES_PASSWORD=x \
  -e POSTGRES_USER=prestidata -e POSTGRES_DB=prestidata postgres:16-alpine
zcat <file>.sql.gz | docker exec -i pgtest psql -q -U prestidata -d prestidata
docker exec pgtest psql -U prestidata -d prestidata -c '\dt'
docker rm -f pgtest
```

To restore **over production** (destructive — the dump is `--clean --if-exists`,
so it drops existing objects first):
```sh
cd /opt/prestidata
docker compose -f docker-compose.prod.yml stop backend   # no writes mid-restore
zcat <file>.sql.gz | docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U prestidata -d prestidata
docker compose -f docker-compose.prod.yml start backend
```
The dump carries the `alembic_version` row, so the restored DB reports the schema
revision it was taken at; a newer image will migrate it forward on next start.

## 6. Email sign-in (Amazon SES)

Sign-in codes are emailed via SES. `terraform apply` creates the domain identity,
a configuration set (bounce/complaint metrics), and grants the instance role
`ses:SendEmail` — but sending needs two manual steps:

**a. Verify the domain.** Publish the three DKIM CNAMEs from the Terraform output
at your DNS host (Squarespace):
```sh
cd terraform && terraform output ses_dns_records
```
Verification flips to *Verified* automatically once they resolve (minutes to a
few hours). Check: SES console -> Identities, or
`aws sesv2 get-email-identity --email-identity abracadata.me --region us-east-2`.

**b. Request production access.** New SES accounts are sandboxed — you can only
send to addresses you've verified. In the SES console choose **Account dashboard
-> Request production access**, describe the use case (transactional sign-in
codes only, with the sign-up flow and bounce handling). Approval typically takes
under 24 hours.

Then turn it on:
```sh
# on the box, in /opt/prestidata/.env
MAIL_FROM=Abracadata <login@abracadata.me>
```
and rebuild the web image with `VITE_AUTH_ENABLED=true` (build arg in
`deploy/web.Dockerfile`) so the sign-in UI appears. With `MAIL_FROM` unset the
backend just logs codes, so nothing breaks before SES is ready.

## Later: production hardening

- **RDS:** create a Postgres instance, `pg_dump | pg_restore`, drop the `postgres`
  service, and point `DATABASE_URL` at RDS. Nothing else changes.
- **Auto-deploy, healthchecks/alerts, a second AZ** — when it's more than a POC.

## Local dev is unchanged

Dev stays on your machine: `make -C backend dev-local` + `make -C frontend dev-local`
(or the existing root `docker-compose.yml`). No dev instance in AWS.
