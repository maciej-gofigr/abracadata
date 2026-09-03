"""Admin controls: access is restricted, and the kill switch really stops spend."""

from __future__ import annotations

import os
import tempfile
from typing import Iterator

os.environ["AUTH_DEV_ECHO"] = "1"

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

import app.generate as generate
from app.admin_api import router as admin_router
from app.auth import router as auth_router
from app.db import Base, get_db
from app.models import User

_TMP = os.path.join(tempfile.mkdtemp(prefix="admin_test_"), "t.db")
_engine = create_engine(f"sqlite:///{_TMP}", connect_args={"check_same_thread": False}, future=True)
_Session = sessionmaker(bind=_engine, autoflush=False, autocommit=False, future=True)


@pytest.fixture(scope="module")
def app() -> FastAPI:
    import app.models  # noqa: F401
    Base.metadata.create_all(bind=_engine)

    def _get_db() -> Iterator[Session]:
        db = _Session()
        try:
            yield db
        finally:
            db.close()

    a = FastAPI()
    a.include_router(auth_router)
    a.include_router(admin_router)
    a.include_router(generate.router)

    # mirror main.py's public status route
    from app import flags as _flags
    from fastapi import Depends

    @a.get("/status")
    def status(db: Session = Depends(get_db)) -> dict[str, bool]:
        return {"llm_enabled": _flags.llm_enabled(db)}

    a.dependency_overrides[get_db] = _get_db
    return a


def _sign_in(client: TestClient, email: str) -> None:
    r = client.post("/auth/request", json={"email": email})
    client.post("/auth/verify", json={"email": email, "code": r.json()["dev_code"]})


def _make_admin(email: str) -> None:
    db = _Session()
    db.execute(select(User).where(User.email == email)).scalar_one().is_admin = True
    db.commit()
    db.close()


def test_admin_routes_are_hidden_from_everyone_else(app: FastAPI) -> None:
    anon = TestClient(app)
    # 404, not 403 — the surface shouldn't confirm it exists.
    assert anon.get("/admin/flags").status_code == 404
    assert anon.post("/admin/flags/llm", json={"enabled": False}).status_code == 404

    plain = TestClient(app)
    _sign_in(plain, "notadmin@example.com")
    assert plain.get("/admin/flags").status_code == 404
    assert plain.post("/admin/flags/llm", json={"enabled": False}).status_code == 404


def test_admin_can_toggle_the_kill_switch(app: FastAPI) -> None:
    admin = TestClient(app)
    _sign_in(admin, "boss@example.com")
    _make_admin("boss@example.com")

    assert admin.get("/admin/flags").json()["llm_enabled"] is True
    r = admin.post("/admin/flags/llm", json={"enabled": False})
    assert r.status_code == 200 and r.json()["llm_enabled"] is False
    # recorded who did it, for an audit trail
    assert r.json()["updated_by"] == "boss@example.com"
    # and it persists for a fresh client
    assert TestClient(app).get("/status").json() == {"llm_enabled": False}

    admin.post("/admin/flags/llm", json={"enabled": True})
    assert TestClient(app).get("/status").json() == {"llm_enabled": True}


def test_kill_switch_blocks_generation_without_calling_bedrock(app: FastAPI, monkeypatch) -> None:
    """The point of the switch: no billable call may happen while it's off."""
    called = False

    def _boom(*a, **k):
        nonlocal called
        called = True
        raise AssertionError("Bedrock must not be called while generation is paused")

    monkeypatch.setattr(generate, "_stream_turn", _boom)

    admin = TestClient(app)
    _sign_in(admin, "boss2@example.com")
    _make_admin("boss2@example.com")
    admin.post("/admin/flags/llm", json={"enabled": False})

    client = TestClient(app)
    body = {"inputs": [{"alias": "o", "columns": ["A"], "dtypes": ["int64"]}],
            "transcript": [{"role": "user", "text": "total by A"}]}
    text = client.post("/generate", json=body).text
    assert "paused" in text
    assert client.post("/suggest", json={"inputs": body["inputs"]}).json() == {"suggestions": []}
    assert called is False

    admin.post("/admin/flags/llm", json={"enabled": True})


def test_cost_errors_are_not_cached_but_successes_are(app: FastAPI, monkeypatch) -> None:
    """A failed cost lookup must not be sticky.

    Otherwise granting the permission would appear to do nothing for six hours,
    and the only fix would be restarting the server.
    """
    import app.admin_api as admin_api

    admin = TestClient(app)
    _sign_in(admin, "cost@example.com")
    _make_admin("cost@example.com")
    admin_api._cost_cache["at"] = None
    admin_api._cost_cache["data"] = None

    # 1. Permission missing -> error, and nothing is cached.
    def _denied():
        raise RuntimeError("AccessDenied")

    monkeypatch.setattr(admin_api, "_fetch_costs", _denied)
    r = admin.get("/admin/costs").json()
    assert r["error"] and r["total"] == 0.0
    assert admin_api._cost_cache["data"] is None, "an error must never be cached"

    # 2. Permission granted -> the very next request retries and succeeds.
    def _ok():
        return admin_api.CostResponse(
            month="September 2026", total=12.34, currency="USD",
            by_service=[{"service": "Amazon EC2", "amount": 12.34}],
            cached_at="now",
        )

    monkeypatch.setattr(admin_api, "_fetch_costs", _ok)
    r = admin.get("/admin/costs").json()
    assert r["error"] is None and r["total"] == 12.34

    # 3. Success IS cached — a later failure doesn't wipe a good reading.
    monkeypatch.setattr(admin_api, "_fetch_costs", _denied)
    r = admin.get("/admin/costs").json()
    assert r["total"] == 12.34 and r["error"] is None
