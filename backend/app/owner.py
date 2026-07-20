"""Anonymous-owner dependency backed by an ``anon_id`` cookie."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import Depends, Request, Response
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import AnonSession

COOKIE_NAME = "anon_id"
COOKIE_MAX_AGE = 90 * 24 * 3600  # 90 days


def get_owner(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> AnonSession:
    """Return the AnonSession for the caller, creating one if needed.

    Reads the ``anon_id`` cookie. If missing or unknown, a new AnonSession is
    created and the cookie is set. ``last_seen`` is refreshed on every call.
    """
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
