"""Runtime feature switches, stored in the database.

Read on the request path, so keep the queries trivial. Values are stored as
strings for a single generic table; helpers coerce.
"""

from __future__ import annotations

from typing import Optional

from sqlalchemy.orm import Session

from app.models import Setting

# Master switch for anything that costs money per call (Bedrock). Default ON;
# an admin flips it off from /admin when traffic or spend looks abusive.
LLM_ENABLED = "llm_enabled"

_TRUE = {"1", "true", "yes", "on"}


def get_bool(db: Session, key: str, default: bool = True) -> bool:
    row = db.get(Setting, key)
    if row is None or row.value is None:
        return default
    return row.value.strip().lower() in _TRUE


def set_bool(db: Session, key: str, value: bool, actor: Optional[str] = None) -> None:
    row = db.get(Setting, key)
    if row is None:
        row = Setting(key=key)
        db.add(row)
    row.value = "true" if value else "false"
    row.updated_by = actor
    db.commit()


def llm_enabled(db: Session) -> bool:
    return get_bool(db, LLM_ENABLED, default=True)
