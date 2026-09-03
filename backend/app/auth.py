"""Light, passwordless sign-in.

Flow: ``POST /auth/request`` emails a 6-digit code; ``POST /auth/verify`` checks
it, gets-or-creates the user, and links the current anonymous session to that
user — migrating (claiming) the session's anonymous recipes into the account so
nothing is lost. The same email on another device sees the same library.

Email delivery is pluggable. With no mailer configured we log the code; set
``AUTH_DEV_ECHO=1`` to also return it in the response for local testing. In
production you'd wire a real sender (e.g. SES) in ``_send_code``.
"""

from __future__ import annotations

import hashlib
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import AnonSession, LoginAttempt, LoginCode, Recipe, User
from app.owner import Principal, get_principal, get_session

router = APIRouter(prefix="/auth", tags=["auth"])
log = logging.getLogger("app.auth")

CODE_TTL = timedelta(minutes=10)
# Product name used in sign-in emails (frontend's source of truth is branding.ts).
APP_NAME = os.environ.get("APP_NAME", "Abracadata")

# Rate limits for issuing sign-in codes (see _enforce_send_limits).
#
# Deliberately a rolling hourly budget with NO fixed cooldown: a hard wait
# between sends punishes ordinary behaviour (dismissing the dialog, mistyping the
# code, an email that's slow to arrive) at the exact moment someone is trying to
# sign in. A burst is fine; sustained volume to one address is not, because that
# is what an email-bombing attempt looks like.
MAX_PER_EMAIL = 10                      # per address …
EMAIL_WINDOW = timedelta(hours=1)       # … per rolling hour
MAX_PER_IP = 40                         # per client IP …
IP_WINDOW = timedelta(hours=1)          # … per rolling hour


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _hash_code(email: str, code: str) -> str:
    # Bind the hash to the email so a code is only valid for its address.
    return hashlib.sha256(f"{email}:{code}".encode()).hexdigest()


def _normalize(email: str) -> str:
    email = email.strip().lower()
    # Minimal shape check — enough to reject obvious junk without a dep.
    if "@" not in email or "." not in email.split("@")[-1] or len(email) > 320:
        raise HTTPException(status_code=422, detail="Enter a valid email address")
    return email


def _send_code(email: str, code: str) -> None:
    """Deliver the login code.

    Sends via Amazon SES when ``MAIL_FROM`` is set (credentials come from the
    EC2 instance role in prod); otherwise logs the code, which keeps local dev
    working with no mailer. ``AUTH_DEV_ECHO=1`` additionally returns it in the
    response for local testing.
    """
    sender = os.environ.get("MAIL_FROM")
    if not sender:
        log.info("login code for %s: %s", email, code)
        return

    subject = f"{code} is your {APP_NAME} sign-in code"
    text = (
        f"Your {APP_NAME} sign-in code is:\n\n    {code}\n\n"
        f"It expires in {int(CODE_TTL.total_seconds() // 60)} minutes.\n"
        "If you didn't request this, you can ignore this email.\n"
    )
    html = (
        f'<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;'
        f'font-size:15px;line-height:1.5;color:#211c2b">'
        f"<p>Your <strong>{APP_NAME}</strong> sign-in code is:</p>"
        f'<p style="font-size:30px;font-weight:700;letter-spacing:.18em;color:#6a2cd4;margin:18px 0">{code}</p>'
        f"<p>It expires in {int(CODE_TTL.total_seconds() // 60)} minutes.</p>"
        f'<p style="color:#6b6478;font-size:13px">If you didn\'t request this, you can ignore this email.</p>'
        f"</div>"
    )

    try:
        import boto3

        client = boto3.client("sesv2", region_name=os.environ.get("AWS_REGION", "us-east-2"))
        client.send_email(
            FromEmailAddress=sender,
            Destination={"ToAddresses": [email]},
            Content={
                "Simple": {
                    "Subject": {"Data": subject, "Charset": "UTF-8"},
                    "Body": {
                        "Text": {"Data": text, "Charset": "UTF-8"},
                        "Html": {"Data": html, "Charset": "UTF-8"},
                    },
                }
            },
        )
    except Exception:
        # Don't leak whether the address exists; log for us, generic error out.
        log.exception("failed to send login code to %s", email)
        raise HTTPException(status_code=502, detail="Couldn't send the code right now. Please try again.")


class RequestBody(BaseModel):
    email: str


class VerifyBody(BaseModel):
    email: str
    code: str


class MeResponse(BaseModel):
    email: Optional[str] = None


class RequestResponse(BaseModel):
    sent: bool = True
    dev_code: Optional[str] = None


def _client_ip(request: Request) -> str:
    """Caller IP — behind Caddy the real client is the first X-Forwarded-For entry."""
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()[:64]
    return (request.client.host if request.client else "")[:64]


def _retry_after(db: Session, column, value: str, window: timedelta, now: datetime) -> int:
    """Seconds until the oldest attempt in the window ages out (>=1)."""
    oldest = db.execute(
        select(func.min(LoginAttempt.created_at)).where(column == value, LoginAttempt.created_at > now - window)
    ).scalar_one_or_none()
    if oldest is None:
        return 1
    if oldest.tzinfo is None:  # sqlite returns naive datetimes
        oldest = oldest.replace(tzinfo=timezone.utc)
    return max(1, int((oldest + window - now).total_seconds()))


def _too_many(seconds: int) -> HTTPException:
    """429 with a human message and a correct Retry-After header."""
    mins = max(1, round(seconds / 60))
    when = "a minute" if mins <= 1 else f"{mins} minutes"
    return HTTPException(
        status_code=429,
        detail=f"That's a lot of sign-in codes. Please try again in {when}.",
        headers={"Retry-After": str(seconds)},
    )


def _enforce_send_limits(db: Session, email: str, ip: str) -> None:
    """Throttle code requests.

    Sign-in codes are emails we send to an address the *requester* typed, so an
    unthrottled endpoint is an email-bombing tool: it mails strangers unsolicited
    codes, and the resulting spam complaints put the SES account at risk. Limits
    are per-address and per-IP, enforced before anything is sent.
    """
    now = _now()
    recent_email = db.execute(
        select(func.count())
        .select_from(LoginAttempt)
        .where(LoginAttempt.email == email, LoginAttempt.created_at > now - EMAIL_WINDOW)
    ).scalar_one()
    if recent_email >= MAX_PER_EMAIL:
        raise _too_many(_retry_after(db, LoginAttempt.email, email, EMAIL_WINDOW, now))

    if ip:
        recent_ip = db.execute(
            select(func.count())
            .select_from(LoginAttempt)
            .where(LoginAttempt.ip == ip, LoginAttempt.created_at > now - IP_WINDOW)
        ).scalar_one()
        if recent_ip >= MAX_PER_IP:
            raise _too_many(_retry_after(db, LoginAttempt.ip, ip, IP_WINDOW, now))

    db.add(LoginAttempt(email=email, ip=ip))
    # Keep the table small; this is the only place it grows.
    db.execute(delete(LoginAttempt).where(LoginAttempt.created_at < now - timedelta(days=1)))


@router.post("/request", response_model=RequestResponse)
def request_code(
    body: RequestBody, request: Request, db: Session = Depends(get_db)
) -> RequestResponse:
    email = _normalize(body.email)
    _enforce_send_limits(db, email, _client_ip(request))
    # Invalidate any outstanding codes for this address, then issue a fresh one.
    db.execute(delete(LoginCode).where(LoginCode.email == email))
    code = f"{secrets.randbelow(1_000_000):06d}"
    db.add(
        LoginCode(email=email, code_hash=_hash_code(email, code), expires_at=_now() + CODE_TTL)
    )
    db.commit()
    _send_code(email, code)
    dev_code = code if os.environ.get("AUTH_DEV_ECHO") else None
    return RequestResponse(sent=True, dev_code=dev_code)


@router.post("/verify", response_model=MeResponse)
def verify_code(
    body: VerifyBody,
    session: AnonSession = Depends(get_session),
    db: Session = Depends(get_db),
) -> MeResponse:
    email = _normalize(body.email)
    rec = db.execute(
        select(LoginCode).where(LoginCode.email == email).order_by(LoginCode.created_at.desc())
    ).scalars().first()
    if (
        rec is None
        or rec.code_hash != _hash_code(email, body.code.strip())
        or rec.expires_at.replace(tzinfo=timezone.utc) < _now()
    ):
        raise HTTPException(status_code=400, detail="Invalid or expired code")

    # Single-use: clear all codes for this address once one is redeemed.
    db.execute(delete(LoginCode).where(LoginCode.email == email))

    user = db.execute(select(User).where(User.email == email)).scalars().first()
    if user is None:
        user = User(email=email)
        db.add(user)
        db.flush()

    # Claim this session's anonymous recipes into the account, then link the
    # session so this browser now acts as the user.
    for recipe in db.execute(
        select(Recipe).where(Recipe.owner_anon_id == session.id, Recipe.owner_user_id.is_(None))
    ).scalars():
        recipe.owner_user_id = user.id
        recipe.owner_anon_id = None
    session.user_id = user.id
    db.commit()
    return MeResponse(email=user.email)


@router.get("/me", response_model=MeResponse)
def me(principal: Principal = Depends(get_principal)) -> MeResponse:
    return MeResponse(email=principal.user.email if principal.user else None)


@router.post("/logout", response_model=MeResponse)
def logout(
    session: AnonSession = Depends(get_session), db: Session = Depends(get_db)
) -> MeResponse:
    # Detach this browser from the account; the account's recipes are untouched.
    session.user_id = None
    db.commit()
    return MeResponse(email=None)
