import json
import os
import tempfile
from typing import Iterator

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

import app.generate as generate
from app.db import Base, get_db
from app.main import app

# /generate and /suggest read the LLM kill switch, so they need a database.
# Point them at a throwaway one: without this the tests would read whatever
# sqlite file happens to be on the machine — passing or failing depending on a
# developer's local flag state, and erroring in CI where no such file exists.
_TMP_DB = os.path.join(tempfile.mkdtemp(prefix="api_test_"), "test.db")
_engine = create_engine(f"sqlite:///{_TMP_DB}", connect_args={"check_same_thread": False}, future=True)
_TestSession = sessionmaker(bind=_engine, autoflush=False, autocommit=False, future=True)

# NB: `from app import models`, not `import app.models` — the latter rebinds the
# name `app` to the package and shadows the FastAPI instance imported above.
from app import models as _models  # noqa: E402,F401  (registers tables)

Base.metadata.create_all(bind=_engine)


def _override_get_db() -> Iterator[Session]:
    db = _TestSession()
    try:
        yield db
    finally:
        db.close()


app.dependency_overrides[get_db] = _override_get_db

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


SCRIPT = (
    "function transform(inputs, params) {\n"
    "  return { tables: { result: inputs.orders }, plots: {} };\n"
    "}\n"
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
    assert tool_use[0]["calls"][0]["input"]["script"].startswith("function transform")


def test_generate_final_via_submit_recipe(monkeypatch):
    def fake_turn(system, messages, tool_config):
        yield ("text", "Done.")
        yield (
            "done",
            [{"toolUse": {"toolUseId": "s1", "name": "submit_recipe", "input": {
                "explanation": "Returns the orders unchanged.",
                "script": SCRIPT,
                "params": [{"name": "n", "type": "number", "default": 5}],
                "steps": [
                    {"title": "Return the orders as-is"},
                    {"title": "", "detail": "dropped: no title"},
                    "Bare string step is coerced",
                ],
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
    assert "function transform(inputs, params)" in final["script"]
    assert final["explanation"] == "Returns the orders unchanged."
    assert final["params"][0]["name"] == "n"
    assert final["submit_id"] == "s1"
    # steps are sanitized: titleless entries dropped, bare strings coerced.
    assert [s["title"] for s in final["steps"]] == [
        "Return the orders as-is",
        "Bare string step is coerced",
    ]


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
    assert msgs[0]["role"] == "user" and "inputs.orders" in msgs[0]["content"][0]["text"]
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


def test_parse_suggestions():
    assert generate._parse_suggestions('["Total by region", "Top 10 orders."]') == ["Total by region", "Top 10 orders"]
    # tolerant of surrounding prose / markdown fences
    assert generate._parse_suggestions('Here you go:\n```json\n["A", "B"]\n```') == ["A", "B"]
    assert generate._parse_suggestions("not json") == []
    assert len(generate._parse_suggestions('["1","2","3","4","5","6"]')) == 4  # capped


def test_suggest_empty_and_mock(monkeypatch):
    assert client.post("/suggest", json={"inputs": []}).json() == {"suggestions": []}
    monkeypatch.setenv("MOCK_GENERATE", "1")
    r = client.post("/suggest", json={"inputs": [{"alias": "orders", "columns": ["Amount"], "dtypes": ["float64"]}]})
    assert r.status_code == 200 and len(r.json()["suggestions"]) >= 1


def test_extract_script_ignores_trailing_json_knob_block():
    text = (
        "Here's a recipe.\n\n"
        "```javascript\nfunction transform(inputs, params) {\n"
        "  return { tables: { result: inputs.orders }, plots: {} };\n}\n```\n\n"
        '```json\n[{"name": "min_amount", "label": "Min", "type": "currency", "default": 100}]\n```'
    )
    script = generate.extract_script(text)
    assert script is not None and script.startswith("function transform")
    assert "function transform(inputs, params)" in script
    assert "min_amount" not in script  # the json block is not the script

    params = generate.extract_params(text)
    assert params == [
        {"name": "min_amount", "label": "Min", "type": "currency", "default": 100}
    ]


def test_sanitize_params_source():
    text = (
        "```json\n[" +
        '{"name":"group_by","type":"enum","default":"Region","source":{"from":"columns","input":"orders"}},' +
        '{"name":"status","type":"enum","default":"paid","source":{"from":"values","input":"orders","column":"Status"}},' +
        '{"name":"bad","type":"enum","default":"x","source":{"from":"values","input":"o"}},'  # values w/o column -> source dropped -> no options -> whole knob dropped
        '{"name":"junk","type":"enum","default":"x","source":{"from":"nope"}}'  # invalid source -> dropped (no options)
        "]\n```"
    )
    params = generate.extract_params(text)
    names = [p["name"] for p in params]
    assert names == ["group_by", "status"]
    assert params[0]["source"] == {"from": "columns", "input": "orders"}
    assert params[1]["source"] == {"from": "values", "input": "orders", "column": "Status"}


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
    assert "transform" in final["script"]
    assert final["params"] and final["params"][0]["name"] == "min_amount"
