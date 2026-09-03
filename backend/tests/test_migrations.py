"""Migrations must stay in sync with the models.

The failure this guards against: someone edits a model but forgets to generate
a revision. Tests (which build their schema straight from the models) stay
green, while production — whose schema only changes via migrations — ends up
missing the column and errors at runtime.
"""

from __future__ import annotations

import os
import tempfile

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _config(url: str) -> Config:
    cfg = Config(os.path.join(BACKEND_DIR, "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(BACKEND_DIR, "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)
    return cfg


@pytest.fixture()
def migrated_url(monkeypatch) -> str:
    """A fresh sqlite database with every migration applied."""
    path = os.path.join(tempfile.mkdtemp(prefix="mig_test_"), "m.db")
    url = f"sqlite:///{path}"
    monkeypatch.setenv("DATABASE_URL", url)
    command.upgrade(_config(url), "head")
    return url


def test_migrations_produce_the_model_schema(migrated_url: str) -> None:
    """After upgrading to head, autogenerate should detect nothing to do."""
    from app.db import Base
    from app import models  # noqa: F401  (registers tables)

    engine = create_engine(migrated_url)
    with engine.connect() as conn:
        ctx = MigrationContext.configure(conn, opts={"compare_type": True})
        diff = compare_metadata(ctx, Base.metadata)

    assert diff == [], (
        "Models and migrations have drifted. Generate a revision:\n"
        "  cd backend && alembic revision --autogenerate -m '<what changed>'\n"
        f"Pending changes: {diff}"
    )


def test_schema_has_expected_tables_and_admin_flag(migrated_url: str) -> None:
    insp = inspect(create_engine(migrated_url))
    tables = set(insp.get_table_names())
    assert {"users", "anon_sessions", "recipes", "recipe_versions",
            "login_codes", "login_attempts"} <= tables
    cols = {c["name"]: c for c in insp.get_columns("users")}
    assert "is_admin" in cols
    assert cols["is_admin"]["nullable"] is False


def test_single_migration_head() -> None:
    """Branching heads would make `upgrade head` ambiguous at deploy time."""
    script = ScriptDirectory.from_config(_config("sqlite://"))
    assert len(script.get_heads()) == 1, f"expected one head, got {script.get_heads()}"
