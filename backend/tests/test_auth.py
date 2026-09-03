"""Tests for passwordless sign-in and user-scoped recipe ownership.

Isolated like test_recipes: an in-file temp sqlite DB via a get_db override, so
these never touch the shared module engine or the real dev DB.
"""

from __future__ import annotations

import os
import tempfile
from datetime import timedelta
from typing import Iterator

os.environ["AUTH_DEV_ECHO"] = "1"  # request returns the code for testing

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from fastapi import HTTPException

import app.auth as auth
from app.auth import router as auth_router
from app.db import Base, get_db
from app.recipes import router as recipes_router

_TMP_DB = os.path.join(tempfile.mkdtemp(prefix="auth_test_"), "test.db")
_engine = create_engine(
    f"sqlite:///{_TMP_DB}", connect_args={"check_same_thread": False}, future=True
)
_TestSession = sessionmaker(bind=_engine, autoflush=False, autocommit=False, future=True)


@pytest.fixture(scope="module")
def app() -> FastAPI:
    import app.models  # noqa: F401

    Base.metadata.create_all(bind=_engine)

    def _override_get_db() -> Iterator[Session]:
        db = _TestSession()
        try:
            yield db
        finally:
            db.close()

    fastapi_app = FastAPI()
    fastapi_app.include_router(auth_router)
    fastapi_app.include_router(recipes_router)
    fastapi_app.dependency_overrides[get_db] = _override_get_db
    return fastapi_app


@pytest.fixture(autouse=True)
def _relax_send_limits(monkeypatch):
    """Most tests here exercise the sign-in flow, not the throttle — the 60s
    per-address cooldown would otherwise block their repeated sign-ins.
    The limiter itself is covered by the dedicated tests at the end."""
    monkeypatch.setattr(auth, "MAX_PER_EMAIL", 10_000)
    monkeypatch.setattr(auth, "MAX_PER_IP", 10_000)


def _sign_in(client: TestClient, email: str) -> None:
    r = client.post("/auth/request", json={"email": email})
    assert r.status_code == 200, r.text
    code = r.json()["dev_code"]
    assert code and len(code) == 6
    r = client.post("/auth/verify", json={"email": email, "code": code})
    assert r.status_code == 200, r.text
    assert r.json()["email"] == email.strip().lower()


def _make_recipe(client: TestClient, name: str) -> str:
    r = client.post("/recipes", json={"name": name, "script": "x=1", "params": [], "inputs": []})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_me_anonymous_then_signed_in(app: FastAPI) -> None:
    client = TestClient(app)
    assert client.get("/auth/me").json() == {"email": None, "is_admin": False}
    _sign_in(client, "Alice@Example.com ")  # normalization: trims + lowercases
    assert client.get("/auth/me").json() == {"email": "alice@example.com", "is_admin": False}


def test_bad_code_rejected(app: FastAPI) -> None:
    client = TestClient(app)
    client.post("/auth/request", json={"email": "bob@example.com"})
    r = client.post("/auth/verify", json={"email": "bob@example.com", "code": "000000"})
    assert r.status_code == 400


def test_invalid_email_rejected(app: FastAPI) -> None:
    client = TestClient(app)
    assert client.post("/auth/request", json={"email": "not-an-email"}).status_code == 422


def test_sign_in_claims_anonymous_recipes(app: FastAPI) -> None:
    client = TestClient(app)
    # Made while anonymous...
    _make_recipe(client, "Anon work")
    assert {r["name"] for r in client.get("/recipes").json()} == {"Anon work"}
    # ...are claimed into the account on sign-in.
    _sign_in(client, "claimer@example.com")
    assert {r["name"] for r in client.get("/recipes").json()} == {"Anon work"}


def test_cross_device_and_isolation(app: FastAPI) -> None:
    # Device A signs in and saves a recipe.
    dev_a = TestClient(app)
    _sign_in(dev_a, "shared@example.com")
    _make_recipe(dev_a, "Monthly close")

    # Device B (fresh cookie jar) signs in with the same email -> sees it.
    dev_b = TestClient(app)
    _sign_in(dev_b, "shared@example.com")
    assert {r["name"] for r in dev_b.get("/recipes").json()} == {"Monthly close"}

    # A different account does not.
    other = TestClient(app)
    _sign_in(other, "stranger@example.com")
    assert other.get("/recipes").json() == []


def test_logout_detaches_browser(app: FastAPI) -> None:
    client = TestClient(app)
    _sign_in(client, "logout@example.com")
    _make_recipe(client, "Kept on the account")
    assert len(client.get("/recipes").json()) == 1

    assert client.post("/auth/logout").json() == {"email": None, "is_admin": False}
    assert client.get("/auth/me").json() == {"email": None, "is_admin": False}
    # Detached browser is anonymous again and no longer sees the account's recipes.
    assert client.get("/recipes").json() == []

    # Signing back in restores access.
    _sign_in(client, "logout@example.com")
    assert {r["name"] for r in client.get("/recipes").json()} == {"Kept on the account"}


def test_send_code_logs_when_no_mailer(monkeypatch, caplog):
    """With MAIL_FROM unset (dev), the code is logged rather than emailed."""
    monkeypatch.delenv("MAIL_FROM", raising=False)
    with caplog.at_level("INFO"):
        auth._send_code("someone@example.com", "123456")
    assert "123456" in caplog.text


def test_send_code_sends_via_ses(monkeypatch):
    """With MAIL_FROM set, it sends through SES with both text and HTML parts."""
    sent = {}

    class FakeSES:
        def send_email(self, **kw):
            sent.update(kw)

    monkeypatch.setenv("MAIL_FROM", "Abracadata <login@abracadata.me>")
    monkeypatch.setattr("boto3.client", lambda *a, **k: FakeSES())
    auth._send_code("someone@example.com", "123456")

    assert sent["FromEmailAddress"] == "Abracadata <login@abracadata.me>"
    assert sent["Destination"]["ToAddresses"] == ["someone@example.com"]
    body = sent["Content"]["Simple"]
    assert "123456" in body["Subject"]["Data"]
    assert "123456" in body["Body"]["Text"]["Data"]
    assert "123456" in body["Body"]["Html"]["Data"]


def test_send_code_surfaces_send_failure(monkeypatch):
    """A failed send must not silently report success to the caller."""
    class BoomSES:
        def send_email(self, **kw):
            raise RuntimeError("SES is unhappy")

    monkeypatch.setenv("MAIL_FROM", "login@abracadata.me")
    monkeypatch.setattr("boto3.client", lambda *a, **k: BoomSES())
    with pytest.raises(HTTPException) as e:
        auth._send_code("someone@example.com", "123456")
    assert e.value.status_code == 502


def test_back_to_back_codes_are_allowed(app: FastAPI, monkeypatch):
    """No fixed cooldown: a user who dismissed the dialog can resend at once.

    This is the legitimate case a hard 60s wait used to block.
    """
    client = TestClient(app)
    monkeypatch.setattr(auth, "MAX_PER_EMAIL", 10)
    for _ in range(3):
        r = client.post("/auth/request", json={"email": "burst@example.com"})
        assert r.status_code == 200, r.text


def test_rate_limit_hourly_cap_per_email(app: FastAPI, monkeypatch):
    """An address is capped per hour even without hitting the cooldown."""
    client = TestClient(app)
    monkeypatch.setattr(auth, "MAX_PER_EMAIL", 3)
    for _ in range(3):
        assert client.post("/auth/request", json={"email": "cap@example.com"}).status_code == 200
    r = client.post("/auth/request", json={"email": "cap@example.com"})
    assert r.status_code == 429


def test_rate_limit_per_ip_across_addresses(app: FastAPI, monkeypatch):
    """One client can't bomb many different addresses (the email-bomb vector).

    Uses a distinct X-Forwarded-For so the count starts clean — which also
    covers the header path we rely on behind Caddy.
    """
    client = TestClient(app)
    monkeypatch.setattr(auth, "MAX_PER_EMAIL", 10_000)
    monkeypatch.setattr(auth, "MAX_PER_IP", 3)
    hdr = {"x-forwarded-for": "203.0.113.7, 10.0.0.1"}  # client first, then proxy
    for i in range(3):
        r = client.post("/auth/request", json={"email": f"v{i}@example.com"}, headers=hdr)
        assert r.status_code == 200, r.text
    r = client.post("/auth/request", json={"email": "v99@example.com"}, headers=hdr)
    assert r.status_code == 429
    # a different client IP is unaffected
    r = client.post("/auth/request", json={"email": "other@example.com"},
                    headers={"x-forwarded-for": "198.51.100.4"})
    assert r.status_code == 200, r.text


def test_no_email_is_sent_when_rate_limited(app: FastAPI, monkeypatch):
    """The throttle must run BEFORE delivery — a blocked request sends nothing."""
    client = TestClient(app)
    monkeypatch.setattr(auth, "MAX_PER_EMAIL", 1)
    sent: list[str] = []
    monkeypatch.setattr(auth, "_send_code", lambda e, c: sent.append(e))
    assert client.post("/auth/request", json={"email": "quiet@example.com"}).status_code == 200
    assert client.post("/auth/request", json={"email": "quiet@example.com"}).status_code == 429
    assert sent == ["quiet@example.com"]  # exactly one send, not two


def test_rate_limited_response_is_friendly_and_retryable(app: FastAPI, monkeypatch):
    """A throttled user gets a human message + Retry-After, not a bare status."""
    client = TestClient(app)
    monkeypatch.setattr(auth, "MAX_PER_EMAIL", 1)
    client.post("/auth/request", json={"email": "polite@example.com"})
    r = client.post("/auth/request", json={"email": "polite@example.com"})
    assert r.status_code == 429
    detail = r.json()["detail"]
    assert "try again in" in detail.lower()
    assert "429" not in detail                     # no raw status leaking to users
    assert int(r.headers["Retry-After"]) > 0


def test_is_admin_surfaces_but_is_never_settable_by_the_client(app: FastAPI) -> None:
    """The UI needs the flag; the API must not let anyone grant it to themselves."""
    from sqlalchemy import select

    from app.models import User

    client = TestClient(app)
    # A normal account is not an admin, and can't ask to be one.
    _sign_in(client, "normal@example.com")
    assert client.get("/auth/me").json()["is_admin"] is False
    client.post("/auth/request", json={"email": "normal@example.com", "is_admin": True})
    assert client.get("/auth/me").json()["is_admin"] is False

    # Granted out of band (as `python -m app.admin grant` does), it surfaces.
    db = _TestSession()
    db.execute(select(User).where(User.email == "normal@example.com")).scalar_one().is_admin = True
    db.commit()
    db.close()
    assert client.get("/auth/me").json()["is_admin"] is True
