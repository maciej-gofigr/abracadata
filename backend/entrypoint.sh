#!/bin/sh
# Bring the database schema up to date, then serve. Migrations run here (not
# only from the app) so a failure aborts the deploy loudly instead of the
# service starting against a stale schema.
set -e
echo "==> applying database migrations"
python -m app.migrate
echo "==> starting API"
exec uvicorn app.main:app --host 0.0.0.0 --port 8000
