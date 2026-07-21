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


def test_extract_script_ignores_trailing_json_knob_block():
    text = (
        "Here's a recipe.\n\n"
        "```python\nimport pandas as pd\n\ndef transform(inputs, params):\n"
        '    return {"tables": {"result": inputs["orders"]}, "plots": {}}\n```\n\n'
        '```json\n[{"name": "min_amount", "label": "Min", "type": "currency", "default": 100}]\n```'
    )
    script = generate.extract_script(text)
    assert script is not None and script.startswith("import pandas")
    assert "def transform(inputs, params)" in script
    assert "min_amount" not in script  # the json block is not the script

    params = generate.extract_params(text)
    assert params == [
        {"name": "min_amount", "label": "Min", "type": "currency", "default": 100}
    ]


def test_extract_params_sanitizes_bad_specs():
    # enum without options is dropped; unknown type coerces to text; junk skipped
    text = (
        "```json\n"
        '[{"name": "g", "type": "enum", "default": "A"},'
        ' {"name": "n", "type": "weird", "default": 5},'
        ' {"label": "no name", "default": 1},'
        ' {"name": "ok", "type": "number", "default": 3, "min": 0}]\n```'
    )
    params = generate.extract_params(text)
    names = [p["name"] for p in params]
    assert names == ["n", "ok"]
    assert params[0]["type"] == "text"  # coerced
    assert params[1]["min"] == 0


def test_mock_generate_returns_params(monkeypatch):
    monkeypatch.setenv("MOCK_GENERATE", "1")
    events = []
    with client.stream(
        "POST", "/generate", json={"messages": [{"role": "user", "text": "hi"}]}
    ) as r:
        for line in r.iter_lines():
            if line.startswith("data:"):
                events.append(json.loads(line[len("data:") :].strip()))
    done = [e for e in events if e.get("done")][0]
    assert "def transform" in done["script"]
    assert done["params"] and done["params"][0]["name"] == "min_amount"
