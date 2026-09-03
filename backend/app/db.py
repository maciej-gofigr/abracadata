"""Database engine, session, and base declarative class.

SQLAlchemy 2.0 style (sync). The database URL is read from ``DATABASE_URL``;
it defaults to a local sqlite file under ``./data/app.db``.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./data/app.db")

_is_sqlite = DATABASE_URL.startswith("sqlite")
_connect_args = {"check_same_thread": False} if _is_sqlite else {}

engine = create_engine(
    DATABASE_URL,
    connect_args=_connect_args,
    future=True,
    # For Postgres (prod), validate pooled connections so a DB restart / idle
    # timeout doesn't surface as a stale-connection error.
    pool_pre_ping=not _is_sqlite,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


class Base(DeclarativeBase):
    pass


def _ensure_sqlite_dir() -> None:
    """Create the parent directory for a file-based sqlite DB if needed."""
    if not _is_sqlite:
        return
    # sqlite:///./data/app.db  -> ./data/app.db ; sqlite:////abs/path -> /abs/path
    path = DATABASE_URL.split("sqlite:///", 1)[-1]
    if path and path != ":memory:":
        db_path = Path(path)
        if db_path.parent and not db_path.parent.exists():
            db_path.parent.mkdir(parents=True, exist_ok=True)


def init_db() -> None:
    """Bring the schema up to date (and create the sqlite data dir if needed).

    Uses Alembic rather than ``create_all``: create_all only creates *missing
    tables*, so it silently skips new columns on existing tables — which passes
    locally and then breaks production. In prod the container entrypoint also
    runs the migrations before serving; this call keeps local dev seamless and
    is a no-op when the schema is already current.
    """
    _ensure_sqlite_dir()
    from app.migrate import run_migrations

    run_migrations()


def get_db() -> Iterator[Session]:
    """FastAPI dependency yielding a scoped database session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
