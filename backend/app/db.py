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

engine = create_engine(DATABASE_URL, connect_args=_connect_args, future=True)

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
    """Create all tables (and the sqlite data dir if applicable)."""
    _ensure_sqlite_dir()
    # Import models so they are registered on Base.metadata before create_all.
    from app import models  # noqa: F401

    Base.metadata.create_all(bind=engine)


def get_db() -> Iterator[Session]:
    """FastAPI dependency yielding a scoped database session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
