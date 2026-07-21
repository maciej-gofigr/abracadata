"""Agentic recipe generation via Claude on Amazon Bedrock (boto3 Converse tool use).

The backend is a **stateless, per-turn oracle**: each POST /generate is exactly one
Converse call. It returns either tool calls for the *frontend* to execute (against the
data in the browser's Pyodide worker) or a final recipe. The frontend owns the agent
loop and re-posts the growing transcript each turn. See docs/agent-harness-design.md.

The backend never executes user code — tools run in the sandboxed worker client-side.

The anthropic SDK's Bedrock clients don't work in this account, so we call
bedrock-runtime Converse directly with boto3. ``us.anthropic.claude-opus-4-6-v1`` is
the best Opus tier this account reaches today (override via BEDROCK_MODEL).
"""

from __future__ import annotations

import json
import os
import random
import re
import time
from typing import Any, Iterator

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

router = APIRouter()

AWS_REGION = os.environ.get("AWS_REGION", "us-east-2")
# Sonnet 4.6 via the GLOBAL cross-region profile: fast, and this account has invoke
# access (sonnet-5 / opus-4-8 are AccessDenied here). "global." routes across more
# regions than "us." → better on-demand capacity / less throttling. Override via env.
BEDROCK_MODEL = os.environ.get("BEDROCK_MODEL", "global.anthropic.claude-sonnet-4-6")
# Cheap/fast model for one-shot prompt suggestions on file upload.
SUGGEST_MODEL = os.environ.get("SUGGEST_MODEL", "global.anthropic.claude-haiku-4-5-20251001-v1:0")
MAX_TOKENS = int(os.environ.get("BEDROCK_MAX_TOKENS", "8192"))

# Adaptive retries add client-side throttle handling on top of our own backoff —
# the agent makes several Converse calls per generation, so throttling matters.
_bedrock = boto3.client(
    "bedrock-runtime",
    region_name=AWS_REGION,
    config=Config(
        retries={"max_attempts": 8, "mode": "adaptive"},
        connect_timeout=10,
        read_timeout=300,
    ),
)

# Bedrock capacity/rate errors that are worth retrying with backoff.
_TRANSIENT = {
    "ThrottlingException",
    "ServiceUnavailableException",
    "TooManyRequestsException",
    "ModelNotReadyException",
    "ModelTimeoutException",
}


def _error_code(exc: Exception) -> str:
    resp = getattr(exc, "response", None)
    if isinstance(resp, dict):
        return resp.get("Error", {}).get("Code", "")
    return ""


def _is_transient(exc: Exception) -> bool:
    return _error_code(exc) in _TRANSIENT or "Too many connections" in str(exc)


def _converse_stream(**kwargs: Any) -> Any:
    """converse_stream with exponential backoff for capacity/throttle errors."""
    delay = 1.0
    last: Exception | None = None
    for attempt in range(5):
        try:
            return _bedrock.converse_stream(**kwargs)
        except ClientError as exc:
            last = exc
            if _is_transient(exc) and attempt < 4:
                time.sleep(min(delay, 12) + random.uniform(0, 0.5))
                delay *= 2
                continue
            raise
    assert last is not None
    raise last


def _friendly_error(exc: Exception) -> str:
    if _is_transient(exc):
        return "The AI service is busy right now — please wait a few seconds and try again."
    return f"{type(exc).__name__}: {exc}"

SYSTEM_PROMPT = """You are the recipe agent inside a data-transformation tool for non-technical office workers. The user loaded one or more tabular files (each a pandas DataFrame) and describes what they want in plain language. Your job: produce ONE tested pandas recipe.

You work in a loop using tools. A good loop is: understand the request → (optionally) inspect the data → write the transform → TEST it with run_recipe → fix any error → submit_recipe. Simple requests may need no inspection and one test.

TOOLS
- preview_rows(alias, n): see the first n real rows of an input — use to learn actual value formats (dates, "$1,200" strings, casing). (Only available when the user allows data access.)
- column_profile(alias, column): for a text column, unique count + most common values; for a numeric column, min/max/mean + null count. Use to learn exact category labels to group/filter by, to check join keys match across files, and to spot values needing cleanup. (Only when data access is allowed.)
- run_recipe(script, params?): RUN your candidate transform on the real data. Returns output table shapes (and a small sample of rows, if data access is allowed) OR the Python error traceback. ALWAYS run_recipe and see it succeed before submitting. If it errors, read the traceback, fix the script, and run again.
- ask_user(question): ask ONE short clarifying question — ONLY when the request is genuinely ambiguous and no reasonable default exists. Strongly prefer making a sensible assumption and letting the user revise later.
- submit_recipe(explanation, script, params): finish. Call ONLY after run_recipe succeeded on the current script.

THE RECIPE (the `script` you write and submit)
- Define exactly: def transform(inputs: dict, params: dict) -> dict
- `inputs` is keyed by the aliases in the dataset context (e.g. inputs["orders"]). `params` holds adjustable values.
- Return {"tables": {name: DataFrame, ...}, "plots": {name: figure, ...}} — 1+ tables, 0+ plots; names are short and human-readable.
- Charts: call these helpers (already in scope — do NOT import or redefine them, and do NOT import plotly):
    plot_bar(x, y, title=None, xlabel=None, ylabel=None)
    plot_line(x, y, title=None, xlabel=None, ylabel=None)
    plot_scatter(x, y, title=None, xlabel=None, ylabel=None)
    plot_pie(labels, values, title=None)
  They return Plotly figure dicts.
- Use only pandas, numpy, and the Python standard library. No file or network I/O. `import pandas as pd` at the top.
- Be robust to messy real-world data (strip whitespace, coerce types), but never silently drop data unless the user asked for a filter.

ADJUSTABLE SETTINGS (the `params` you submit)
- Identify 0-4 simple scalars a non-technical user might tweak later WITHOUT re-describing the recipe: thresholds, a group-by column, a top-N count, a date cutoff, an on/off toggle. Don't invent knobs that aren't central to the request.
- In the script, read each knob via params.get("key", DEFAULT) — using .get with a default means the recipe still runs if a value is absent.
- submit_recipe's `params` is an array of objects: {"name": the exact params key, "label": short human label, "type": "number"|"currency"|"date"|"enum"|"bool"|"text", "default": the default value}. Optional: "options" (array of strings, REQUIRED for "enum"), "min"/"max"/"step" (number/currency), "help" (short hint). Use "currency" for money, "enum" (with options) for a value from a fixed set like a column name. Every knob's name must be a key the script reads. Use [] if there are no sensible knobs.

Keep explanations plain and short (1-3 sentences, no jargon). When revising after user feedback, produce the full updated script and re-test it."""


# --------------------------------------------------------------------------- #
# Tool specs (Converse toolConfig)
# --------------------------------------------------------------------------- #
def _tool(name: str, description: str, props: dict, required: list[str]) -> dict:
    return {
        "toolSpec": {
            "name": name,
            "description": description,
            "inputSchema": {"json": {"type": "object", "properties": props, "required": required}},
        }
    }


_PREVIEW_ROWS = _tool(
    "preview_rows",
    "Get the first n real rows of an input table to see actual values and formats.",
    {
        "alias": {"type": "string", "description": "Input alias, e.g. 'orders'."},
        "n": {"type": "integer", "description": "Rows to return (1-20).", "default": 5},
    },
    ["alias"],
)
_COLUMN_PROFILE = _tool(
    "column_profile",
    "Profile one column: text -> unique count + most common values; numeric -> min/max/mean + nulls.",
    {"alias": {"type": "string"}, "column": {"type": "string"}},
    ["alias", "column"],
)
_RUN_RECIPE = _tool(
    "run_recipe",
    "Run a candidate transform(inputs, params) on the real data. Returns output table shapes (and sample rows if allowed) or the Python traceback. Always test before submitting.",
    {
        "script": {"type": "string", "description": "Full Python script defining transform(inputs, params)."},
        "params": {"type": "object", "description": "Optional param values to run with."},
    },
    ["script"],
)
_ASK_USER = _tool(
    "ask_user",
    "Ask the user ONE short clarifying question. Only when genuinely ambiguous; prefer a sensible assumption.",
    {"question": {"type": "string"}},
    ["question"],
)
_SUBMIT_RECIPE = _tool(
    "submit_recipe",
    "Submit the final, tested recipe. Call only after run_recipe succeeded on this script.",
    {
        "explanation": {"type": "string", "description": "1-3 plain-language sentences describing what the recipe does."},
        "script": {"type": "string"},
        "params": {"type": "array", "items": {"type": "object"}, "description": "Adjustable-knob specs (see system prompt)."},
    },
    ["explanation", "script"],
)

_EXECUTABLE_TOOLS = {"preview_rows", "column_profile", "run_recipe"}


def _tool_config(allow_data_access: bool) -> dict:
    tools = [_RUN_RECIPE, _ASK_USER, _SUBMIT_RECIPE]
    if allow_data_access:
        tools = [_PREVIEW_ROWS, _COLUMN_PROFILE] + tools
    return {"tools": tools}


# --------------------------------------------------------------------------- #
# Request model + transcript -> Converse translation
# --------------------------------------------------------------------------- #
class InputSpec(BaseModel):
    alias: str
    columns: list[str] = []
    dtypes: list[str] = []


class ToolCall(BaseModel):
    id: str
    name: str
    input: dict[str, Any] = {}


class ToolResult(BaseModel):
    id: str
    ok: bool = True
    content: Any = None


class TurnMessage(BaseModel):
    role: str  # "user" | "assistant" | "tool"
    text: str | None = None
    tool_calls: list[ToolCall] = []
    results: list[ToolResult] = []


class GenerateRequest(BaseModel):
    inputs: list[InputSpec] = []
    allow_data_access: bool = True
    transcript: list[TurnMessage] = []


class SuggestRequest(BaseModel):
    inputs: list[InputSpec] = []


def _dataset_context(inputs: list[InputSpec], allow_data_access: bool) -> str:
    lines = ["The user loaded these input tables (reference them by alias inside transform(inputs, params)):"]
    for inp in inputs:
        cols = ", ".join(
            f"{c} ({t})" for c, t in zip(inp.columns, inp.dtypes or [""] * len(inp.columns))
        )
        lines.append(f'- inputs["{inp.alias}"]: {cols}')
    if not allow_data_access:
        lines.append(
            "The user has turned OFF data access: preview_rows/column_profile are unavailable and run_recipe "
            "returns only shapes (no cell values). Rely on the schema above and on run_recipe's shapes/errors."
        )
    return "\n".join(lines)


def _as_json_obj(value: Any) -> Any:
    return value if isinstance(value, (dict, list)) else {"value": value}


def _to_converse(req: GenerateRequest) -> list[dict[str, Any]]:
    ctx = _dataset_context(req.inputs, req.allow_data_access)
    out: list[dict[str, Any]] = []
    first_user = True
    for m in req.transcript:
        if m.role == "user":
            text = m.text or ""
            if first_user and req.inputs:
                text = f"{ctx}\n\nUser request: {text}"
            first_user = False
            out.append({"role": "user", "content": [{"text": text}]})
        elif m.role == "assistant":
            content: list[dict[str, Any]] = []
            if m.text:
                content.append({"text": m.text})
            for c in m.tool_calls:
                content.append({"toolUse": {"toolUseId": c.id, "name": c.name, "input": c.input}})
            out.append({"role": "assistant", "content": content or [{"text": ""}]})
        elif m.role == "tool":
            content = []
            for r in m.results:
                if r.ok:
                    content.append({"toolResult": {"toolUseId": r.id, "content": [{"json": _as_json_obj(r.content)}], "status": "success"}})
                else:
                    content.append({"toolResult": {"toolUseId": r.id, "content": [{"text": str(r.content)}], "status": "error"}})
            out.append({"role": "user", "content": content})
    return out


# --------------------------------------------------------------------------- #
# Lenient fallback parsing (model returned prose/code instead of submit_recipe)
# --------------------------------------------------------------------------- #
def _code_blocks(text: str) -> list[tuple[str, str]]:
    return [
        (lang.lower(), body)
        for lang, body in re.findall(r"```([A-Za-z0-9_+-]*)[ \t]*\n(.*?)```", text, re.DOTALL)
    ]


def extract_script(text: str) -> str | None:
    blocks = _code_blocks(text)
    for lang, body in reversed(blocks):
        if lang in ("", "python", "py") and "def transform" in body:
            return body.strip()
    for lang, body in reversed(blocks):
        if lang in ("", "python", "py"):
            return body.strip()
    return None


_ALLOWED_PARAM_TYPES = {"number", "currency", "date", "enum", "bool", "text"}


def _sanitize_params(data: Any) -> list[dict[str, Any]]:
    if not isinstance(data, list):
        return []
    out: list[dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict) or "default" not in item:
            continue
        name = item.get("name")
        if not isinstance(name, str) or not name:
            continue
        ptype = item.get("type")
        if ptype not in _ALLOWED_PARAM_TYPES:
            ptype = "text"
        if ptype == "enum" and not (isinstance(item.get("options"), list) and item["options"]):
            continue
        knob: dict[str, Any] = {
            "name": name,
            "label": item.get("label") if isinstance(item.get("label"), str) and item.get("label") else name,
            "type": ptype,
            "default": item["default"],
        }
        for key in ("options", "min", "max", "step", "help"):
            if item.get(key) is not None:
                knob[key] = item[key]
        out.append(knob)
        if len(out) >= 8:
            break
    return out


def extract_params(text: str) -> list[dict[str, Any]]:
    for lang, body in reversed(_code_blocks(text)):
        if lang == "json":
            try:
                return _sanitize_params(json.loads(body.strip()))
            except Exception:
                continue
    return []


def _strip_code(text: str) -> str:
    return re.sub(r"```[\s\S]*?```", "", text).strip()


# --------------------------------------------------------------------------- #
# One streamed Converse turn -> (text deltas, assembled assistant blocks, stop)
# --------------------------------------------------------------------------- #
def _stream_turn(system: str, messages: list[dict[str, Any]], tool_config: dict) -> Iterator[Any]:
    """Yield ('text', delta) for each text delta, then ('done', blocks, stop_reason)."""
    resp = _converse_stream(
        modelId=BEDROCK_MODEL,
        system=[{"text": system}],
        messages=messages,
        toolConfig=tool_config,
        inferenceConfig={"maxTokens": MAX_TOKENS},
    )
    blocks: dict[int, dict[str, Any]] = {}
    stop = "end_turn"
    for event in resp["stream"]:
        if "contentBlockStart" in event:
            e = event["contentBlockStart"]
            start = e.get("start", {})
            if "toolUse" in start:
                blocks[e["contentBlockIndex"]] = {
                    "type": "tool",
                    "id": start["toolUse"]["toolUseId"],
                    "name": start["toolUse"]["name"],
                    "input": "",
                }
        elif "contentBlockDelta" in event:
            e = event["contentBlockDelta"]
            idx = e["contentBlockIndex"]
            d = e["delta"]
            if "text" in d:
                b = blocks.setdefault(idx, {"type": "text", "text": ""})
                b["text"] += d["text"]
                yield ("text", d["text"])
            elif "toolUse" in d:
                blocks[idx]["input"] += d["toolUse"].get("input", "")
        elif "messageStop" in event:
            stop = event["messageStop"].get("stopReason", stop)

    assembled: list[dict[str, Any]] = []
    for idx in sorted(blocks):
        b = blocks[idx]
        if b["type"] == "text":
            if b["text"]:
                assembled.append({"text": b["text"]})
        else:
            inp: Any = {}
            if b["input"].strip():
                try:
                    inp = json.loads(b["input"])
                except Exception:
                    inp = {}
            assembled.append({"toolUse": {"toolUseId": b["id"], "name": b["name"], "input": inp}})
    yield ("done", assembled, stop)


def _sse(obj: dict[str, Any]) -> str:
    return f"data: {json.dumps(obj)}\n\n"


# --------------------------------------------------------------------------- #
# Prompt suggestions — one fast Haiku call on file upload (schema only).
# --------------------------------------------------------------------------- #
SUGGEST_SYSTEM = """You help non-technical office workers use a spreadsheet tool. Given the loaded table(s) and their columns, propose 3-4 SHORT, SPECIFIC, genuinely useful things they'd likely want to do — summarize, filter, rank, chart, or (if there are 2+ tables) join them. Phrase each as a plain request they could type, imperative voice, <= 12 words, concrete to the ACTUAL column names shown. Reply with ONLY a JSON array of strings — no prose, no markdown."""


def _schema_lines(inputs: list[InputSpec]) -> str:
    lines = []
    for inp in inputs:
        cols = ", ".join(
            f"{c} ({t})" for c, t in zip(inp.columns, inp.dtypes or [""] * len(inp.columns))
        )
        lines.append(f'- "{inp.alias}": {cols}')
    return "\n".join(lines)


def _parse_suggestions(text: str) -> list[str]:
    m = re.search(r"\[[\s\S]*\]", text)
    if not m:
        return []
    try:
        arr = json.loads(m.group(0))
    except Exception:
        return []
    out: list[str] = []
    for s in arr:
        if isinstance(s, str) and s.strip():
            out.append(s.strip().rstrip("."))
        if len(out) >= 4:
            break
    return out


@router.post("/suggest")
def suggest(req: SuggestRequest) -> dict[str, list[str]]:
    """Best-effort: returns [] on any failure so it never blocks the UI."""
    if not req.inputs:
        return {"suggestions": []}
    if os.environ.get("MOCK_GENERATE"):
        return {"suggestions": ["Total the amount by region", "Show the top 10 rows by amount", "Count rows per category"]}
    prompt = f"Loaded tables:\n{_schema_lines(req.inputs)}\n\nSuggest 3-4 things to do. JSON array of strings only."
    try:
        resp = _bedrock.converse(
            modelId=SUGGEST_MODEL,
            system=[{"text": SUGGEST_SYSTEM}],
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig={"maxTokens": 300, "temperature": 0.7},
        )
        text = resp["output"]["message"]["content"][0]["text"]
        return {"suggestions": _parse_suggestions(text)}
    except Exception:
        return {"suggestions": []}


def _assistant_neutral(blocks: list[dict[str, Any]]) -> dict[str, Any]:
    text = "".join(b["text"] for b in blocks if "text" in b)
    calls = [
        {"id": b["toolUse"]["toolUseId"], "name": b["toolUse"]["name"], "input": b["toolUse"]["input"]}
        for b in blocks
        if "toolUse" in b
    ]
    return {"role": "assistant", "text": text or None, "tool_calls": calls}


# --------------------------------------------------------------------------- #
# Mock (offline / docker without AWS): submit a canned recipe on turn 1.
# --------------------------------------------------------------------------- #
_MOCK_RECIPE = '''import pandas as pd

def transform(inputs, params):
    orders = inputs["orders"]
    customers = inputs["customers"]
    df = orders.merge(customers, on="Customer ID", how="left")
    df["Amount"] = df["Amount"].astype(float)
    df = df[df["Amount"] >= params.get("min_amount", 0)]
    summary = (df.groupby("Segment", as_index=False)
                 .agg(Orders=("Order ID", "count"), **{"Total Revenue": ("Amount", "sum")})
                 .sort_values("Total Revenue", ascending=False))
    chart = plot_pie(summary["Segment"], summary["Total Revenue"], title="Revenue share by segment")
    return {"tables": {"By segment": summary}, "plots": {"Revenue by segment": chart}}'''

_MOCK_PARAMS = [
    {"name": "min_amount", "label": "Minimum order amount", "type": "currency", "default": 0, "min": 0, "step": 50, "help": "Orders below this are dropped"}
]


@router.post("/generate")
def generate(req: GenerateRequest) -> StreamingResponse:
    if os.environ.get("MOCK_GENERATE"):
        def mock() -> Iterator[str]:
            yield _sse({"text": "Joining orders to customers and charting revenue share by segment."})
            yield _sse({
                "type": "final",
                "assistant": {"role": "assistant", "text": None, "tool_calls": [{"id": "mock", "name": "submit_recipe", "input": {}}]},
                "submit_id": "mock",
                "script": _MOCK_RECIPE,
                "params": _MOCK_PARAMS,
                "explanation": "Joins orders to customers and shows revenue share by segment as a pie chart.",
            })
        return StreamingResponse(mock(), media_type="text/event-stream")

    if not req.transcript:
        def empty() -> Iterator[str]:
            yield _sse({"type": "error", "error": "no message provided"})
        return StreamingResponse(empty(), media_type="text/event-stream")

    messages = _to_converse(req)
    tool_config = _tool_config(req.allow_data_access)

    def gen() -> Iterator[str]:
        blocks: list[dict[str, Any]] = []
        try:
            for ev in _stream_turn(SYSTEM_PROMPT, messages, tool_config):
                if ev[0] == "text":
                    yield _sse({"text": ev[1]})
                else:
                    blocks = ev[1]
        except Exception as exc:
            yield _sse({"type": "error", "error": _friendly_error(exc)})
            return

        assistant = _assistant_neutral(blocks)
        tool_uses = {c["name"]: c for c in assistant["tool_calls"]}

        if "submit_recipe" in tool_uses:
            inp = tool_uses["submit_recipe"]["input"] or {}
            yield _sse({
                "type": "final",
                "assistant": assistant,
                "submit_id": tool_uses["submit_recipe"]["id"],
                "script": inp.get("script") or "",
                "params": _sanitize_params(inp.get("params") or []),
                "explanation": inp.get("explanation") or (assistant["text"] or "").strip(),
            })
            return

        if "ask_user" in tool_uses:
            yield _sse({
                "type": "question",
                "assistant": assistant,
                "ask_id": tool_uses["ask_user"]["id"],
                "question": tool_uses["ask_user"]["input"].get("question", ""),
            })
            return

        exec_calls = [c for c in assistant["tool_calls"] if c["name"] in _EXECUTABLE_TOOLS]
        if exec_calls:
            yield _sse({"type": "tool_use", "assistant": assistant, "calls": exec_calls})
            return

        # Lenient fallback: model replied with prose/code instead of a tool call.
        full = assistant["text"] or ""
        script = extract_script(full)
        if script:
            yield _sse({
                "type": "final",
                "assistant": assistant,
                "submit_id": None,
                "script": script,
                "params": extract_params(full),
                "explanation": _strip_code(full),
            })
        else:
            yield _sse({"type": "message", "assistant": assistant, "text": full})

    return StreamingResponse(gen(), media_type="text/event-stream")
