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

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import AnonSession, LoginCode, Recipe, User
from app.owner import Principal, get_principal, get_session

router = APIRouter(prefix="/auth", tags=["auth"])
log = logging.getLogger("app.auth")

CODE_TTL = timedelta(minutes=10)
# Product name used in sign-in emails (frontend's source of truth is branding.ts).
APP_NAME = os.environ.get("APP_NAME", "Abracadata")


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


@router.post("/request", response_model=RequestResponse)
def request_code(body: RequestBody, db: Session = Depends(get_db)) -> RequestResponse:
    email = _normalize(body.email)
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
