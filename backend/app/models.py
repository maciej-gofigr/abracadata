"""SQLAlchemy ORM models for recipe persistence + versioning.

Recipes belong to an anonymous session (cookie-based owner). Versions are
immutable snapshots of a recipe's script + params + inputs + prompt.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from app.db import Base


def _uuid_hex() -> str:
    return uuid4().hex


def _now() -> datetime:
    return datetime.now(timezone.utc)


class AnonSession(Base):
    __tablename__ = "anon_sessions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    created_at: Mapped[datetime] = mapped_column(default=_now)
    last_seen: Mapped[datetime] = mapped_column(default=_now)

    recipes: Mapped[list["Recipe"]] = relationship(
        back_populates="owner", cascade="all, delete-orphan"
    )


class Recipe(Base):
    __tablename__ = "recipes"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    owner_anon_id: Mapped[str] = mapped_column(
        ForeignKey("anon_sessions.id"), index=True
    )
    name: Mapped[str] = mapped_column(String(255))
    current_version_id: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=_now)
    updated_at: Mapped[datetime] = mapped_column(default=_now, onupdate=_now)

    owner: Mapped["AnonSession"] = relationship(back_populates="recipes")
    versions: Mapped[list["RecipeVersion"]] = relationship(
        back_populates="recipe",
        cascade="all, delete-orphan",
        order_by="RecipeVersion.version_no",
    )


class RecipeVersion(Base):
    __tablename__ = "recipe_versions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    recipe_id: Mapped[str] = mapped_column(
        ForeignKey("recipes.id", ondelete="CASCADE"), index=True
    )
    version_no: Mapped[int] = mapped_column(Integer)
    script: Mapped[str] = mapped_column(Text)
    params_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    inputs_json: Mapped[Any] = mapped_column(JSON, default=list)
    prompt: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=_now)

    recipe: Mapped["Recipe"] = relationship(back_populates="versions")
