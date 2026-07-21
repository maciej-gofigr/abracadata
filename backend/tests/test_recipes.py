"""Tests for the recipe persistence + versioning API.

We do NOT import ``app.main`` (owned by another process). We mount the recipes
router on a minimal FastAPI app and override ``get_db`` with a session bound to
an isolated temp sqlite DB. Overriding the dependency (rather than relying on
the ``DATABASE_URL`` env var) keeps these tests isolated from the shared module
engine and the real dev DB regardless of test import order.
"""

from __future__ import annotations

import os
import tempfile
from typing import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db import Base, get_db
from app.recipes import router as recipes_router

_TMP_DB = os.path.join(tempfile.mkdtemp(prefix="recipes_test_"), "test.db")
_test_engine = create_engine(
    f"sqlite:///{_TMP_DB}", connect_args={"check_same_thread": False}, future=True
)
_TestSession = sessionmaker(bind=_test_engine, autoflush=False, autocommit=False, future=True)


@pytest.fixture(scope="module")
def app() -> FastAPI:
    import app.models  # noqa: F401 — register tables on Base.metadata

    Base.metadata.create_all(bind=_test_engine)

    def _override_get_db() -> Iterator[Session]:
        db = _TestSession()
        try:
            yield db
        finally:
            db.close()

    fastapi_app = FastAPI()
    fastapi_app.include_router(recipes_router)
    fastapi_app.dependency_overrides[get_db] = _override_get_db
    return fastapi_app


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    # TestClient persists cookies across requests by default.
    return TestClient(app)


def test_share_flow(app: FastAPI) -> None:
    owner = TestClient(app)
    r = owner.post("/recipes", json={
        "name": "Shared one", "script": "print('x')",
        "params": [{"name": "n", "type": "number", "default": 5}],
        "param_values": {"n": 9},
        "inputs": [{"alias": "orders", "columns": ["Order ID"]}],
    })
    rid = r.json()["id"]
    assert r.json()["share_token"] is None

    # Enable sharing -> get a token.
    r = owner.post(f"/recipes/{rid}/share")
    token = r.json()["share_token"]
    assert token and len(token) > 10
    # Idempotent: sharing again keeps the same token.
    assert owner.post(f"/recipes/{rid}/share").json()["share_token"] == token
    # List surfaces the token to the owner.
    assert owner.get("/recipes").json()[0]["share_token"] == token

    # A DIFFERENT visitor (fresh cookie jar, no access to the owner's library)
    # can fetch the shared recipe by token — the transformation, no owner info.
    visitor = TestClient(app)
    assert visitor.get("/recipes").json() == []  # can't see the owner's library
    s = visitor.get(f"/recipes/shared/{token}")
    assert s.status_code == 200
    body = s.json()
    assert body["name"] == "Shared one"
    assert body["script"] == "print('x')"
    assert body["param_values"] == {"n": 9}
    assert "owner" not in body and "id" not in body  # no owner/identity leak

    # The visitor can save a copy into THEIR own library (fork).
    copy = visitor.post("/recipes", json={"name": "Shared one (copy)", "script": body["script"], "params": body["params"], "inputs": body["inputs"]})
    assert copy.status_code == 201
    assert {x["name"] for x in visitor.get("/recipes").json()} == {"Shared one (copy)"}

    # Revoke -> the link 404s.
    owner.delete(f"/recipes/{rid}/share")
    assert owner.get("/recipes").json()[0]["share_token"] is None
    assert visitor.get(f"/recipes/shared/{token}").status_code == 404


def test_shared_unknown_token_404(client: TestClient) -> None:
    assert client.get("/recipes/shared/nope-not-a-real-token").status_code == 404


def test_create_list_get_version_flow(client: TestClient) -> None:
    # Create
    r = client.post(
        "/recipes",
        json={
            "name": "Revenue by region",
            "script": "print('v1')",
            "params": {"min_amount": 100},
            "inputs": [{"alias": "orders", "columns": ["id"], "dtypes": ["int64"]}],
            "prompt": "summarize revenue",
        },
    )
    assert r.status_code == 201, r.text
    created = r.json()
    recipe_id = created["id"]
    assert created["current_version"]["version_no"] == 1
    assert created["current_version"]["script"] == "print('v1')"
    assert created["current_version_id"] == created["current_version"]["id"]

    # A cookie should now be set for the owner.
    assert client.cookies.get("anon_id")

    # List
    r = client.get("/recipes")
    assert r.status_code == 200
    listing = r.json()
    assert len(listing) == 1
    assert listing[0]["id"] == recipe_id
    assert listing[0]["name"] == "Revenue by region"
    assert listing[0]["version_count"] == 1

    # Get
    r = client.get(f"/recipes/{recipe_id}")
    assert r.status_code == 200
    detail = r.json()
    assert detail["current_version"]["params"] == {"min_amount": 100}
    assert detail["current_version"]["inputs"][0]["alias"] == "orders"

    # Add a version -> version_no increments to 2 and becomes current
    r = client.post(
        f"/recipes/{recipe_id}/versions",
        json={"script": "print('v2')", "params": {}, "inputs": [], "prompt": "tweak"},
    )
    assert r.status_code == 201, r.text
    v2 = r.json()
    assert v2["current_version"]["version_no"] == 2
    assert v2["current_version"]["script"] == "print('v2')"
    assert v2["current_version_id"] == v2["current_version"]["id"]

    # version_count is now 2
    r = client.get("/recipes")
    assert r.json()[0]["version_count"] == 2

    # List versions, newest first
    r = client.get(f"/recipes/{recipe_id}/versions")
    assert r.status_code == 200
    versions = r.json()
    assert [v["version_no"] for v in versions] == [2, 1]
    assert versions[0]["prompt"] == "tweak"

    # Rename
    r = client.patch(f"/recipes/{recipe_id}", json={"name": "Renamed"})
    assert r.status_code == 200
    assert r.json()["name"] == "Renamed"


def test_param_values_round_trip(client: TestClient) -> None:
    # Saving last-used knob values persists them and reopening restores them.
    r = client.post(
        "/recipes",
        json={
            "name": "Knobbed",
            "script": "print('x')",
            "params": [{"name": "min_amount", "label": "Min", "type": "currency", "default": 100}],
            "param_values": {"min_amount": 500},
            "inputs": [],
        },
    )
    assert r.status_code == 201, r.text
    recipe_id = r.json()["id"]
    assert r.json()["current_version"]["param_values"] == {"min_amount": 500}

    # Reopen (GET) returns the saved values, not the spec default.
    detail = client.get(f"/recipes/{recipe_id}").json()
    assert detail["current_version"]["param_values"] == {"min_amount": 500}

    # A new version carries its own values.
    r = client.post(
        f"/recipes/{recipe_id}/versions",
        json={"script": "print('y')", "params": [], "param_values": {"min_amount": 250}, "inputs": []},
    )
    assert r.json()["current_version"]["param_values"] == {"min_amount": 250}

    # The version list surfaces each version's params + saved values.
    versions = client.get(f"/recipes/{recipe_id}/versions").json()
    by_no = {v["version_no"]: v for v in versions}
    assert by_no[1]["param_values"] == {"min_amount": 500}
    assert by_no[1]["params"][0]["name"] == "min_amount"
    assert by_no[2]["param_values"] == {"min_amount": 250}

    # Omitting param_values defaults to an empty dict (back-compat).
    r = client.post(
        "/recipes",
        json={"name": "No knobs", "script": "print('z')", "params": [], "inputs": []},
    )
    assert r.json()["current_version"]["param_values"] == {}


def test_ownership_isolation(app: FastAPI) -> None:
    owner_a = TestClient(app)
    owner_b = TestClient(app)  # fresh cookie jar

    # Owner A creates a recipe.
    r = owner_a.post(
        "/recipes",
        json={"name": "A's secret", "script": "x=1", "params": {}, "inputs": []},
    )
    assert r.status_code == 201
    recipe_id = r.json()["id"]

    # Owner B cannot see it in the list...
    r = owner_b.get("/recipes")
    assert r.status_code == 200
    assert all(item["id"] != recipe_id for item in r.json())

    # ...nor fetch it directly (404)...
    assert owner_b.get(f"/recipes/{recipe_id}").status_code == 404
    # ...nor its versions, nor mutate it.
    assert owner_b.get(f"/recipes/{recipe_id}/versions").status_code == 404
    assert owner_b.patch(f"/recipes/{recipe_id}", json={"name": "hijack"}).status_code == 404
    assert owner_b.delete(f"/recipes/{recipe_id}").status_code == 404
    assert (
        owner_b.post(
            f"/recipes/{recipe_id}/versions",
            json={"script": "y=2", "params": {}, "inputs": []},
        ).status_code
        == 404
    )

    # Owner A still owns it.
    assert owner_a.get(f"/recipes/{recipe_id}").status_code == 200


def test_delete_removes_recipe_and_versions(client: TestClient) -> None:
    r = client.post(
        "/recipes",
        json={"name": "To delete", "script": "z=0", "params": {}, "inputs": []},
    )
    recipe_id = r.json()["id"]
    assert client.delete(f"/recipes/{recipe_id}").status_code == 204
    assert client.get(f"/recipes/{recipe_id}").status_code == 404
