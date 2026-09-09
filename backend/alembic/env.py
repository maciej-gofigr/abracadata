"""Alembic environment.

Schema changes are versioned here rather than created ad hoc: SQLAlchemy's
``create_all`` only creates *missing tables*, so it silently ignores new columns
on existing tables — which would pass locally and break production.

The database URL comes from the app (``DATABASE_URL``), so migrations always
target the same database the service uses.
"""

import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

# Import the app's metadata so `--autogenerate` can diff models against the DB.
from app.db import DATABASE_URL as APP_DATABASE_URL, Base
from app import models  # noqa: F401  (registers the tables on Base.metadata)

config = context.config
# Read the environment here rather than trusting app.db's import-time constant:
# that module may have been imported earlier (e.g. by another test) against a
# different database, and migrations must target the one configured *now*.
DATABASE_URL = os.environ.get("DATABASE_URL") or APP_DATABASE_URL
config.set_main_option("sqlalchemy.url", DATABASE_URL.replace("%", "%%"))

if config.config_file_name is not None:
    # disable_existing_loggers=False is essential, not tidiness. Migrations also
    # run IN-PROCESS inside the API (init_db() in the FastAPI lifespan), and
    # fileConfig defaults to disabling every logger absent from alembic.ini —
    # whose [loggers] section lists only root, sqlalchemy and alembic. That
    # silently switched off uvicorn.error and uvicorn.access one second after
    # every boot, so the API emitted no access logs at all. When the box died of
    # an OOM on 2026-09-09 there was consequently no record of which request was
    # responsible.
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=DATABASE_URL,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            # sqlite can't ALTER most things in place; batch mode rewrites the
            # table instead, so the same migrations work in local dev.
            render_as_batch=connection.dialect.name == "sqlite",
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
