import json

from fastapi.testclient import TestClient

import app.generate as generate
from app.main import app

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


SCRIPT = (
    "import pandas as pd\n\n"
    "def transform(inputs, params):\n"
    '    return {"tables": {"result": inputs["orders"]}, "plots": {}}\n'
)


def _events(r):
    out = []
    for line in r.iter_lines():
        if line.startswith("data:"):
            out.append(json.loads(line[len("data:"):].strip()))
    return out


def test_generate_streams_then_tool_use(monkeypatch):
    # Model streams some thinking, then calls run_recipe -> backend returns tool_use.
    def fake_turn(system, messages, tool_config):
        yield ("text", "Let me test this. ")
        yield (
            "done",
            [{"text": "Let me test this. "},
             {"toolUse": {"toolUseId": "t1", "name": "run_recipe", "input": {"script": SCRIPT}}}],
            "tool_use",
        )

    monkeypatch.setattr(generate, "_stream_turn", fake_turn)
    payload = {
        "inputs": [{"alias": "orders", "columns": ["Order ID"], "dtypes": ["int64"]}],
        "allow_data_access": True,
        "transcript": [{"role": "user", "text": "return the orders"}],
    }
    with client.stream("POST", "/generate", json=payload) as r:
        assert r.status_code == 200
        events = _events(r)
    assert any("text" in e for e in events)
    tool_use = [e for e in events if e.get("type") == "tool_use"]
    assert len(tool_use) == 1
    assert tool_use[0]["calls"][0]["name"] == "run_recipe"
    assert tool_use[0]["calls"][0]["input"]["script"].startswith("import pandas")


def test_generate_final_via_submit_recipe(monkeypatch):
    def fake_turn(system, messages, tool_config):
        yield ("text", "Done.")
        yield (
            "done",
            [{"toolUse": {"toolUseId": "s1", "name": "submit_recipe", "input": {
                "explanation": "Returns the orders unchanged.",
                "script": SCRIPT,
                "params": [{"name": "n", "type": "number", "default": 5}],
            }}}],
            "tool_use",
        )

    monkeypatch.setattr(generate, "_stream_turn", fake_turn)
    payload = {
        "inputs": [{"alias": "orders", "columns": ["Order ID"], "dtypes": ["int64"]}],
        "transcript": [{"role": "user", "text": "return the orders"}],
    }
    with client.stream("POST", "/generate", json=payload) as r:
        events = _events(r)
    final = [e for e in events if e.get("type") == "final"][0]
    assert "def transform(inputs, params)" in final["script"]
    assert final["explanation"] == "Returns the orders unchanged."
    assert final["params"][0]["name"] == "n"
    assert final["submit_id"] == "s1"


def test_generate_ask_user(monkeypatch):
    def fake_turn(system, messages, tool_config):
        yield (
            "done",
            [{"toolUse": {"toolUseId": "a1", "name": "ask_user", "input": {"question": "Which column is revenue?"}}}],
            "tool_use",
        )

    monkeypatch.setattr(generate, "_stream_turn", fake_turn)
    payload = {"transcript": [{"role": "user", "text": "chart revenue"}]}
    with client.stream("POST", "/generate", json=payload) as r:
        events = _events(r)
    q = [e for e in events if e.get("type") == "question"][0]
    assert q["question"] == "Which column is revenue?"
    assert q["ask_id"] == "a1"


def test_to_converse_maps_tools_and_results():
    req = generate.GenerateRequest(
        inputs=[generate.InputSpec(alias="orders", columns=["Order ID"], dtypes=["int64"])],
        transcript=[
            generate.TurnMessage(role="user", text="return the orders"),
            generate.TurnMessage(role="assistant", tool_calls=[generate.ToolCall(id="t1", name="run_recipe", input={"script": "x"})]),
            generate.TurnMessage(role="tool", results=[generate.ToolResult(id="t1", ok=True, content={"tables": []})]),
        ],
    )
    msgs = generate._to_converse(req)
    assert msgs[0]["role"] == "user" and "inputs[\"orders\"]" in msgs[0]["content"][0]["text"]
    assert msgs[1]["role"] == "assistant" and msgs[1]["content"][0]["toolUse"]["name"] == "run_recipe"
    assert msgs[2]["role"] == "user" and msgs[2]["content"][0]["toolResult"]["status"] == "success"


def test_tool_config_respects_data_access():
    names_on = {t["toolSpec"]["name"] for t in generate._tool_config(True)["tools"]}
    names_off = {t["toolSpec"]["name"] for t in generate._tool_config(False)["tools"]}
    assert {"preview_rows", "column_profile"} <= names_on
    assert "run_recipe" in names_off and "preview_rows" not in names_off


def test_generate_rejects_malformed_transcript():
    # transcript[].role is required
    r = client.post("/generate", json={"transcript": [{"text": "no role"}]})
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


def test_mock_generate_returns_final(monkeypatch):
    monkeypatch.setenv("MOCK_GENERATE", "1")
    with client.stream(
        "POST", "/generate", json={"transcript": [{"role": "user", "text": "hi"}]}
    ) as r:
        events = _events(r)
    final = [e for e in events if e.get("type") == "final"][0]
    assert "def transform" in final["script"]
    assert final["params"] and final["params"][0]["name"] == "min_amount"
