"""Apply database migrations.

Run at deploy time (the container entrypoint) and from ``init_db`` for local
dev, so the schema is always current before the app serves traffic.

Handles three cases:

* **Fresh database** — no tables at all: apply every revision from scratch.
* **Already managed** — an ``alembic_version`` table exists: apply what's new.
* **Pre-Alembic database** — tables exist but were created by the old
  ``Base.metadata.create_all`` (this is production as of the switch). Those
  tables match the initial revision, so stamp it as applied rather than trying
  to re-create them, then continue with the later revisions.
"""

from __future__ import annotations

import logging
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import inspect

from app.db import engine

log = logging.getLogger("app.migrate")

BACKEND_DIR = Path(__file__).resolve().parent.parent
# The revision whose schema is identical to what create_all used to build.
INITIAL_REVISION = "f4a4296245e8"


def _config() -> Config:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    return cfg


def run_migrations() -> None:
    cfg = _config()
    tables = set(inspect(engine).get_table_names())

    if "alembic_version" not in tables and "users" in tables:
        log.info("adopting pre-Alembic database: stamping %s", INITIAL_REVISION)
        command.stamp(cfg, INITIAL_REVISION)

    command.upgrade(cfg, "head")
    log.info("database schema is up to date")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    run_migrations()
