from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_generate_stub_shape():
    payload = {
        "inputs": [
            {"alias": "orders", "columns": ["Order ID", "Amount"], "dtypes": ["int64", "float64"]}
        ],
        "params": {"min_amount": 100},
        "messages": [{"role": "user", "text": "summarize revenue by region"}],
    }
    r = client.post("/generate", json=payload)
    assert r.status_code == 200
    body = r.json()
    assert "text" in body
    # stub — Bedrock isn't wired up yet, so no script is returned
    assert body["script"] is None


def test_generate_rejects_malformed_message():
    # messages[].role is required
    r = client.post("/generate", json={"messages": [{"text": "no role"}]})
    assert r.status_code == 422
