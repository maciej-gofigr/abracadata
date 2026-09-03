"""SQLAlchemy ORM models for recipe persistence + versioning.

Recipes belong to an anonymous session (cookie-based owner). Versions are
immutable snapshots of a recipe's script + params + inputs + prompt.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

from sqlalchemy import Boolean, ForeignKey, Integer, String, Text, false
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from app.db import Base


def _uuid_hex() -> str:
    return uuid4().hex


def _now() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    """A signed-in account, keyed by email. Passwordless (email code login)."""

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(default=_now)
    # Elevated access (admin tooling). Never set from user input — grant it
    # deliberately (see `python -m app.admin grant <email>`).
    is_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=false())


class Setting(Base):
    """Server-side switches, editable at runtime by an admin.

    In the database rather than the environment so a change takes effect
    immediately — the LLM kill switch exists for a cost/abuse spike, and
    "redeploy to turn it off" is useless in that moment.
    """

    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(String(255))
    updated_at: Mapped[datetime] = mapped_column(default=_now, onupdate=_now)
    updated_by: Mapped[Optional[str]] = mapped_column(String(320), nullable=True)


class LoginCode(Base):
    """A short-lived, single-use email verification code (stored hashed)."""

    __tablename__ = "login_codes"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    email: Mapped[str] = mapped_column(String(320), index=True)
    code_hash: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(default=_now)


class LoginAttempt(Base):
    """One record per sign-in-code request, for rate limiting.

    Kept separate from LoginCode because issuing a new code deletes the old one
    (only the latest may be redeemed), which would otherwise erase the history
    the limiter needs. Rows are pruned after a day.
    """

    __tablename__ = "login_attempts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    email: Mapped[str] = mapped_column(String(320), index=True)
    ip: Mapped[str] = mapped_column(String(64), index=True, default="")
    created_at: Mapped[datetime] = mapped_column(default=_now, index=True)


class AnonSession(Base):
    __tablename__ = "anon_sessions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    # When set, this browser is signed in as the given user.
    user_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(default=_now)
    last_seen: Mapped[datetime] = mapped_column(default=_now)

    recipes: Mapped[list["Recipe"]] = relationship(
        back_populates="owner", cascade="all, delete-orphan"
    )


class Recipe(Base):
    __tablename__ = "recipes"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid_hex)
    # A recipe is owned by exactly one of: an anonymous session, or a user.
    # Signing in migrates a session's recipes to owner_user_id (see auth.verify).
    owner_anon_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("anon_sessions.id"), nullable=True, index=True
    )
    owner_user_id: Mapped[Optional[str]] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(255))
    current_version_id: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    # When set, the recipe is shareable: anyone with this token can view + run it
    # (public, no auth). Revoking = setting this back to NULL.
    share_token: Mapped[Optional[str]] = mapped_column(
        String(64), unique=True, nullable=True, index=True
    )
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
    # Last-used values for the knobs (keyed by param name) so reopening a recipe
    # restores the user's tweaks rather than resetting to the generated defaults.
    param_values_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    inputs_json: Mapped[Any] = mapped_column(JSON, default=list)
    prompt: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=_now)

    recipe: Mapped["Recipe"] = relationship(back_populates="versions")
