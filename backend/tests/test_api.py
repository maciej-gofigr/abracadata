import json

from fastapi.testclient import TestClient

import app.generate as generate
from app.main import app

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_generate_streams_and_extracts_script(monkeypatch):
    # Mock Bedrock so the test is hermetic (no AWS call).
    def fake_stream(system, messages):
        yield "Here's a recipe.\n\n```python\n"
        yield (
            "import pandas as pd\n\n"
            "def transform(inputs, params):\n"
            '    return {"tables": {"result": inputs["orders"]}, "plots": {}}\n'
        )
        yield "```"

    monkeypatch.setattr(generate, "_stream_deltas", fake_stream)

    payload = {
        "inputs": [{"alias": "orders", "columns": ["Order ID", "Amount"], "dtypes": ["int64", "float64"]}],
        "params": {},
        "messages": [{"role": "user", "text": "just return the orders"}],
    }
    events = []
    with client.stream("POST", "/generate", json=payload) as r:
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        for line in r.iter_lines():
            if line.startswith("data:"):
                events.append(json.loads(line[len("data:") :].strip()))

    assert any("text" in e for e in events)  # streamed deltas
    done = [e for e in events if e.get("done")]
    assert len(done) == 1
    assert "def transform(inputs, params)" in done[0]["script"]


def test_generate_rejects_malformed_message():
    # messages[].role is required
    r = client.post("/generate", json={"messages": [{"text": "no role"}]})
    assert r.status_code == 422
