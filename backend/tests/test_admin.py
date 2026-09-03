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


def _set_budget(db, usd: float) -> None:
    """Pin the ceiling so tests don't depend on the shipped default."""
    from app import usage
    from app.models import Setting

    row = db.get(Setting, usage.DAILY_BUDGET_USD) or Setting(key=usage.DAILY_BUDGET_USD)
    row.value = str(usd)
    db.add(row)
    db.commit()


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


def test_refresh_bypasses_the_cost_cache(app: FastAPI, monkeypatch) -> None:
    """The Refresh button must actually re-query, not re-serve the cached figure."""
    import app.admin_api as admin_api

    admin = TestClient(app)
    _sign_in(admin, "refresh@example.com")
    _make_admin("refresh@example.com")
    admin_api._cost_cache["at"] = None
    admin_api._cost_cache["data"] = None

    calls = {"n": 0}

    def _counting():
        calls["n"] += 1
        return admin_api.CostResponse(
            month="September 2026", total=float(calls["n"]), currency="USD",
            by_service=[], cached_at="now",
        )

    monkeypatch.setattr(admin_api, "_fetch_costs", _counting)

    assert admin.get("/admin/costs").json()["total"] == 1.0   # first, live
    assert admin.get("/admin/costs").json()["total"] == 1.0   # within TTL -> cached
    assert calls["n"] == 1
    assert admin.get("/admin/costs?refresh=true").json()["total"] == 2.0  # forced
    assert calls["n"] == 2
    assert admin.get("/admin/costs").json()["total"] == 2.0   # refresh reseeded the cache
    assert calls["n"] == 2


def test_per_ip_limit_and_budget_backstop(app: FastAPI, monkeypatch) -> None:
    """Two independent ceilings: one abuser, and total daily spend."""
    from app import flags, usage
    from app.db import get_db

    db = next(app.dependency_overrides[get_db]())

    # --- per-IP ceiling
    monkeypatch.setattr(usage, "MAX_CALLS_PER_IP_HOUR", 3)
    for _ in range(3):
        usage.record(db, kind="generate", model="sonnet", ip="203.0.113.9", input_tokens=10, output_tokens=5)
    assert usage.over_ip_limit(db, "203.0.113.9") is True
    assert usage.over_ip_limit(db, "198.51.100.1") is False, "limit must be per-IP, not global"

    # --- token accounting drives cost, not call count
    before = usage.today_totals(db)["estimated_cost"]
    usage.record(db, kind="generate", model="global.anthropic.claude-sonnet-4-6",
                 ip="198.51.100.2", input_tokens=1_000_000, output_tokens=100_000)
    after = usage.today_totals(db)["estimated_cost"]
    assert round(after - before, 2) == 4.50, "1M in @ $3 + 100k out @ $15 = $4.50"

    # --- budget backstop pauses generation and is visible in the same flag
    _set_budget(db, 5.0)
    flags.set_bool(db, flags.LLM_ENABLED, True)
    sent: list[tuple] = []
    monkeypatch.setattr(usage, "_notify_admins", lambda db, s, b, paused: sent.append((s, b, paused)))
    usage.record(db, kind="generate", model="global.anthropic.claude-sonnet-4-6",
                 ip="198.51.100.3", input_tokens=1_000_000, output_tokens=0)
    assert usage.enforce_budget(db) is True          # now over the pinned $5 ceiling
    assert flags.llm_enabled(db) is False, "budget exhaustion must pause generation"
    assert sent and sent[-1][2] is True, "an alert must be raised when auto-pausing"

    flags.set_bool(db, flags.LLM_ENABLED, True)
    db.close()


def test_raising_the_budget_allows_recovery_after_an_auto_pause(app: FastAPI, monkeypatch) -> None:
    """Resuming alone is not enough — the next request would re-pause.

    Without an adjustable ceiling an admin would be stuck until midnight UTC.
    """
    from app import flags, usage

    monkeypatch.setattr(usage, "_notify_admins", lambda *a, **k: None)
    admin = TestClient(app)
    _sign_in(admin, "budget@example.com")
    _make_admin("budget@example.com")

    from app.db import get_db
    db = next(app.dependency_overrides[get_db]())
    _set_budget(db, 5.0)
    usage.record(db, kind="generate", model="global.anthropic.claude-sonnet-4-6",
                 ip="198.51.100.77", input_tokens=3_000_000, output_tokens=0)  # $9 > $5
    assert usage.enforce_budget(db) is True
    assert flags.llm_enabled(db) is False

    # Raise the ceiling, then resume — the next check must now pass.
    r = admin.post("/admin/budget", json={"usd": 50})
    assert r.status_code == 200 and r.json()["budget"] == 50.0
    admin.post("/admin/flags/llm", json={"enabled": True})
    assert usage.enforce_budget(db) is False, "raised budget must let generation continue"
    assert flags.llm_enabled(db) is True

    db.close()
