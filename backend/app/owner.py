"""Caller identity: an ``anon_id`` cookie, optionally linked to a signed-in user.

The anonymous session cookie *is* the session. Signing in links that session to
a :class:`~app.models.User` (see ``app.auth``); the resulting :class:`Principal`
is either anonymous (recipes scoped to the session) or a user (recipes scoped to
the account, visible from any device signed in with the same email).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, Request, Response
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import AnonSession, User

COOKIE_NAME = "anon_id"
COOKIE_MAX_AGE = 90 * 24 * 3600  # 90 days


@dataclass
class Principal:
    """Who is making the request: an anon session, maybe linked to a user."""

    session: AnonSession
    user: Optional[User]


def get_session(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> AnonSession:
    """Return the AnonSession for the caller, creating + cookie-setting if needed."""
    anon_id = request.cookies.get(COOKIE_NAME)
    session: AnonSession | None = None
    if anon_id:
        session = db.get(AnonSession, anon_id)

    if session is None:
        session = AnonSession()
        db.add(session)
        db.flush()  # populate session.id
        response.set_cookie(
            key=COOKIE_NAME,
            value=session.id,
            httponly=True,
            samesite="lax",
            max_age=COOKIE_MAX_AGE,
        )

    session.last_seen = datetime.now(timezone.utc)
    db.commit()
    return session


def get_principal(
    session: AnonSession = Depends(get_session),
    db: Session = Depends(get_db),
) -> Principal:
    """Resolve the caller to a Principal, loading the linked user if signed in."""
    user = db.get(User, session.user_id) if session.user_id else None
    return Principal(session=session, user=user)
