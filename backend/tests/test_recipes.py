"""Tests for the recipe persistence + versioning API.

We do NOT import ``app.main`` (owned by another process). Instead we build a
minimal FastAPI app, mount the recipes router, and use a temp sqlite DB. The
``DATABASE_URL`` env var is set BEFORE importing any ``app`` module so the
engine binds to the temp file.
"""

from __future__ import annotations

import os
import tempfile

# Point the app at an isolated temp sqlite DB before importing app modules.
_TMP_DB = os.path.join(tempfile.mkdtemp(prefix="recipes_test_"), "test.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP_DB}"

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db import init_db
from app.recipes import router as recipes_router


@pytest.fixture(scope="module")
def app() -> FastAPI:
    init_db()
    fastapi_app = FastAPI()
    fastapi_app.include_router(recipes_router)
    return fastapi_app


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    # TestClient persists cookies across requests by default.
    return TestClient(app)


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
