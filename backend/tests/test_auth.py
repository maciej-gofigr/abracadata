"""Tests for passwordless sign-in and user-scoped recipe ownership.

Isolated like test_recipes: an in-file temp sqlite DB via a get_db override, so
these never touch the shared module engine or the real dev DB.
"""

from __future__ import annotations

import os
import tempfile
from typing import Iterator

os.environ["AUTH_DEV_ECHO"] = "1"  # request returns the code for testing

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

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
    assert client.get("/auth/me").json() == {"email": None}
    _sign_in(client, "Alice@Example.com ")  # normalization: trims + lowercases
    assert client.get("/auth/me").json() == {"email": "alice@example.com"}


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

    assert client.post("/auth/logout").json() == {"email": None}
    assert client.get("/auth/me").json() == {"email": None}
    # Detached browser is anonymous again and no longer sees the account's recipes.
    assert client.get("/recipes").json() == []

    # Signing back in restores access.
    _sign_in(client, "logout@example.com")
    assert {r["name"] for r in client.get("/recipes").json()} == {"Kept on the account"}
