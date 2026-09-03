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
from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import flags, usage
from app.db import get_db

router = APIRouter()


def _client_ip(request: Request) -> str:
    """Caller IP — behind Caddy the real client is first in X-Forwarded-For."""
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()[:64]
    return (request.client.host if request.client else "")[:64]

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

SYSTEM_PROMPT = """You are the recipe agent inside a data-transformation tool for non-technical office workers. The user loaded one or more tabular files and describes what they want in plain language. Your job: produce ONE tested JavaScript recipe that runs in the browser.

You work in a loop using tools. A good loop is: understand the request → (optionally) inspect the data → write the transform → TEST it with run_recipe → fix any error → submit_recipe. Simple requests may need no inspection and one test.

TOOLS
- preview_rows(alias, n): see the first n real rows of an input — use to learn actual value formats (dates, "$1,200" strings, casing). (Only available when the user allows data access.)
- column_profile(alias, column): for a text column, unique count + most common values; for a numeric column, min/max/mean + null count. Use to learn exact category labels to group/filter by, to check join keys match across files, and to spot values needing cleanup. (Only when data access is allowed.)
- run_recipe(script, params?): RUN your candidate transform on the real data. Returns output table shapes (and a small sample of rows, if data access is allowed) OR the JavaScript error. ALWAYS run_recipe and see it succeed before submitting. If it errors, read the error, fix the script, and run again.
- ask_user(question): ask ONE short clarifying question — ONLY when the request is genuinely ambiguous and no reasonable default exists. Strongly prefer making a sensible assumption and letting the user revise later.
- submit_recipe(explanation, script, params, steps): finish. Call ONLY after run_recipe succeeded on the current script.

THE RECIPE (the `script` you write and submit)
- Define exactly: function transform(inputs, params) { ... return { tables, plots }; }
- inputs.<alias> is an Arquero table (e.g. inputs.orders), keyed by the aliases in the dataset context. Column names may contain spaces — access them as d['Customer ID']. params holds adjustable values; read them as params.key.
- Return { tables: { "Short Name": <Arquero table OR array of row objects>, ... }, plots: { "Short Name": <figure>, ... } } — 1+ tables, 0+ plots; names are short and human-readable.

ARQUERO (the data library — in scope as `aq`, aggregate ops as `op`; do NOT import anything)
- Verbs: .derive({col: d => EXPR}), .filter(d => COND), .groupby('A','B'), .rollup({ total: op.sum('Amount'), n: op.count() }), .orderby('col' or aq.desc('col')), .select(...), .rename({old: 'new'}), .join_left(other, ['leftKey','rightKey']), .join(other, ['a','b']) (inner join), .dedupe(), .slice(0, 10).
- Aggregates live on op: op.sum, op.mean, op.median, op.min, op.max, op.count, op.distinct.
- To use a param inside an Arquero expression, pass it via .params({ min: params.min_amount ?? 0 }) and read the SECOND arg: .filter((d, $) => d.Amount >= $.min).
- Get an array of row objects with table.objects(); get one column's values with table.array('col').

CLEANUP (real files are messy — the following are in scope as functions AND as op.* inside Arquero expressions)
- op.parseNumber(v): "$1,200.50" -> 1200.5, blank/unparseable -> NaN. Use for money/number columns that may be strings: .derive({ amt: d => op.parseNumber(d.Amount) }) then aggregate `amt`.
- op.parseDate(v) -> timestamp (ms); op.yearMonth(v) -> "2024-03", for grouping by month.
- Be robust: clean and convert values with these, but NEVER silently drop or filter rows unless the user asked for a filter. (Dropping rows whose amount is unparseable NaN is fine when you are summing money.)

CHARTS
- Convenience helpers (in scope; do NOT import or redefine): plotBar(x, y, {title, xlabel, ylabel}), plotLine(x, y, {title, xlabel, ylabel}), plotScatter(x, y, {...}), plotPie(labels, values, {title}). Pass columns from a result table, e.g. plotBar(t.array('Region'), t.array('Revenue'), { title: 'Revenue by region' }).
- These just return plain Plotly figure objects, and the app renders whatever you return with Plotly.js. So for anything the helpers don't cover — other chart types (histogram, box, heatmap, stacked/grouped bars, area, sunburst, …), multiple traces, a secondary axis, or custom styling — RETURN A RAW PLOTLY FIGURE directly: { data: [ { type: 'histogram', x: t.array('Amount') }, … ], layout: { title: { text: '…' }, barmode: 'stack', … } }. The full Plotly schema is available.

Use only Arquero, the helpers above, and plain JavaScript / Math. No imports, no network, no DOM.

ADJUSTABLE SETTINGS (the `params` you submit)
- Identify 0-4 simple scalars a non-technical user might tweak later WITHOUT re-describing the recipe: thresholds, a group-by column, a top-N count, a date cutoff, an on/off toggle. Don't invent knobs that aren't central to the request.
- In the script, read each knob via `params.key ?? DEFAULT` — the fallback means the recipe still runs if a value is absent.
- submit_recipe's `params` is an array of objects: {"name": the exact params key, "label": short human label, "type": "number"|"currency"|"date"|"enum"|"bool"|"text", "default": the default value}. Optional: "options" (array of strings), "min"/"max"/"step" (number/currency), "help" (short hint). Use "currency" for money. Every knob's name must be a key the script reads. Use [] if there are no sensible knobs.
- For a choice whose valid values come from the USER'S DATA, add a "source" (a data-driven dropdown; the user can still type free-form) INSTEAD of hardcoding "options":
    "source": {"from": "columns", "input": "<alias>"}   — the value is a COLUMN NAME; the UI offers that input's actual columns. Omit "input" if there's only one.
    "source": {"from": "values", "input": "<alias>", "column": "<Column>"}   — the value is one of the DISTINCT VALUES in that column.
  Use "source" for a group-by column, a key/join column, or a category/status/region to filter by — it adapts to whatever file the user drops. In the script read it via params.key and resolve columns case-insensitively (and tolerate a value not present). Reserve static "options" for a truly fixed set.

STEPS (the `steps` you submit)
- Also provide `steps`: an ordered list of the transform's stages, distilled for a non-technical reader who will NOT see the code. This drives a visual flow diagram in the UI, so make each step a discrete stage of the pipeline.
- 2-6 steps. Each is {"title": a short imperative phrase in plain English (e.g. "Match each order to its customer", "Keep only 2024 orders", "Total revenue per segment"), "detail": OPTIONAL one short line if a title needs clarifying}.
- Describe WHAT happens to the data in business terms, not code operations — say "Combine the two files by customer", never "join on Customer ID". No column-name jargon, code, or library names. Cover the meaningful stages in order (combine → clean/filter → aggregate → chart), not every line.

Keep explanations plain and short (1-3 sentences, no jargon). When revising after user feedback, produce the full updated script, re-test it, and provide updated steps."""


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
    "Run a candidate transform(inputs, params) on the real data. Returns output table shapes (and sample rows if allowed) or the JavaScript error. Always test before submitting.",
    {
        "script": {"type": "string", "description": "Full JavaScript defining function transform(inputs, params)."},
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
        "steps": {
            "type": "array",
            "description": "Ordered plain-language steps the recipe performs, for a non-technical reader (see system prompt).",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Short imperative step, e.g. 'Total revenue per segment'."},
                    "detail": {"type": "string", "description": "Optional one-line clarification."},
                },
                "required": ["title"],
            },
        },
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
    sample_rows: list[list[Any]] = []  # optional: a few real rows (values), for suggestions


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
        lines.append(f"- inputs.{inp.alias}: {cols}")
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
    _JS = ("", "javascript", "js", "jsx", "ts", "typescript")
    for lang, body in reversed(blocks):
        if lang in _JS and "transform" in body:
            return body.strip()
    for lang, body in reversed(blocks):
        if lang in _JS:
            return body.strip()
    return None


_ALLOWED_PARAM_TYPES = {"number", "currency", "date", "enum", "bool", "text"}


def _clean_source(src: Any) -> dict[str, Any] | None:
    """Validate a param's data-driven `source` (dropdown from columns / values)."""
    if not isinstance(src, dict) or src.get("from") not in ("columns", "values"):
        return None
    out: dict[str, Any] = {"from": src["from"]}
    if isinstance(src.get("input"), str) and src["input"]:
        out["input"] = src["input"]
    if isinstance(src.get("column"), str) and src["column"]:
        out["column"] = src["column"]
    if out["from"] == "values" and "column" not in out:
        return None  # a value dropdown needs a column to read from
    return out


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
        src = _clean_source(item.get("source"))
        if ptype == "enum" and not src and not (isinstance(item.get("options"), list) and item["options"]):
            continue  # a static enum with no options and no data source can't render
        knob: dict[str, Any] = {
            "name": name,
            "label": item.get("label") if isinstance(item.get("label"), str) and item.get("label") else name,
            "type": ptype,
            "default": item["default"],
        }
        if src:
            knob["source"] = src
        for key in ("options", "min", "max", "step", "help"):
            if item.get(key) is not None:
                knob[key] = item[key]
        out.append(knob)
        if len(out) >= 8:
            break
    return out


def _sanitize_steps(data: Any) -> list[dict[str, str]]:
    """Validate the model's `steps` into a list of {title, detail?} (title required)."""
    if not isinstance(data, list):
        return []
    out: list[dict[str, str]] = []
    for item in data:
        title = ""
        detail = ""
        if isinstance(item, dict):
            title = item.get("title") if isinstance(item.get("title"), str) else ""
            detail = item.get("detail") if isinstance(item.get("detail"), str) else ""
        elif isinstance(item, str):
            title = item
        title = (title or "").strip()
        if not title:
            continue
        step = {"title": title}
        if detail and detail.strip():
            step["detail"] = detail.strip()
        out.append(step)
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
    usage: dict[str, int] = {"input": 0, "output": 0}
    for event in resp["stream"]:
        if "metadata" in event:
            u = event["metadata"].get("usage") or {}
            usage["input"] = int(u.get("inputTokens") or 0)
            usage["output"] = int(u.get("outputTokens") or 0)
            yield ("usage", usage)
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
        # A few real rows help ground suggestions in actual values (only sent when
        # the user allows data access; otherwise sample_rows is empty).
        for row in inp.sample_rows[:3]:
            pairs = ", ".join(f"{c}={v}" for c, v in zip(inp.columns, row))
            lines.append(f"    example row: {pairs}")
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
def suggest(request: Request, req: SuggestRequest, db: Session = Depends(get_db)) -> dict[str, list[str]]:
    """Best-effort: returns [] on any failure so it never blocks the UI."""
    if not req.inputs:
        return {"suggestions": []}
    if usage.enforce_budget(db) or not flags.llm_enabled(db):
        return {"suggestions": []}  # kill switch / budget: never spend on a suggestion
    if usage.over_ip_limit(db, _client_ip(request)):
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
        u = resp.get("usage") or {}
        usage.record(db, kind="suggest", model=SUGGEST_MODEL, ip=_client_ip(request),
                     input_tokens=u.get("inputTokens", 0), output_tokens=u.get("outputTokens", 0))
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
_MOCK_RECIPE = '''function transform(inputs, params) {
  const min = params.min_amount ?? 0;
  const summary = inputs.orders
    .join_left(inputs.customers, ['Customer ID', 'Customer ID'])
    .derive({ amt: d => op.parseNumber(d.Amount) })
    .params({ min })
    .filter((d, $) => d.amt >= $.min)
    .groupby('Segment')
    .rollup({ Orders: op.count(), 'Total Revenue': op.sum('amt') })
    .orderby(aq.desc('Total Revenue'));
  return {
    tables: { 'By segment': summary },
    plots: { 'Revenue by segment': plotPie(summary.array('Segment'), summary.array('Total Revenue'), { title: 'Revenue share by segment' }) },
  };
}'''

_MOCK_PARAMS = [
    {"name": "min_amount", "label": "Minimum order amount", "type": "currency", "default": 0, "min": 0, "step": 50, "help": "Orders below this are dropped"}
]


@router.post("/generate")
def generate(request: Request, req: GenerateRequest, db: Session = Depends(get_db)) -> StreamingResponse:
    caller_ip = _client_ip(request)

    # Order matters: the budget check can itself pause the service, so run it
    # before reading the flag.
    budget_exhausted = usage.enforce_budget(db)

    if budget_exhausted or not flags.llm_enabled(db):
        # Kill switch (admin): stop before any billable call is made.
        def disabled() -> Iterator[str]:
            yield _sse({
                "type": "error",
                "error": "Recipe generation is paused right now. Your files and saved recipes are unaffected — please try again a little later.",
            })
        return StreamingResponse(disabled(), media_type="text/event-stream")

    if usage.over_ip_limit(db, caller_ip):
        def limited() -> Iterator[str]:
            yield _sse({
                "type": "error",
                "error": "You've generated a lot of recipes in a short time. Please wait a while and try again.",
            })
        return StreamingResponse(limited(), media_type="text/event-stream")

    if os.environ.get("MOCK_GENERATE"):
        def mock() -> Iterator[str]:
            yield _sse({"text": "Joining orders to customers and charting revenue share by segment."})
            yield _sse({
                "type": "final",
                "assistant": {"role": "assistant", "text": None, "tool_calls": [{"id": "mock", "name": "submit_recipe", "input": {}}]},
                "submit_id": "mock",
                "script": _MOCK_RECIPE,
                "params": _MOCK_PARAMS,
                "steps": [
                    {"title": "Combine orders with customer details"},
                    {"title": "Keep orders at or above the minimum amount"},
                    {"title": "Total revenue and order count per segment"},
                    {"title": "Chart each segment's share of revenue"},
                ],
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
        tokens = {"input": 0, "output": 0}
        try:
            for ev in _stream_turn(SYSTEM_PROMPT, messages, tool_config):
                if ev[0] == "text":
                    yield _sse({"text": ev[1]})
                elif ev[0] == "usage":
                    tokens = ev[1]
                else:
                    blocks = ev[1]
        except Exception as exc:
            yield _sse({"type": "error", "error": _friendly_error(exc)})
            return
        finally:
            # Meter even a failed turn: Bedrock may still have billed for it.
            usage.record(db, kind="generate", model=BEDROCK_MODEL, ip=caller_ip,
                         input_tokens=tokens["input"], output_tokens=tokens["output"])

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
                "steps": _sanitize_steps(inp.get("steps") or []),
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
                "steps": [],
                "explanation": _strip_code(full),
            })
        else:
            yield _sse({"type": "message", "assistant": assistant, "text": full})

    return StreamingResponse(gen(), media_type="text/event-stream")
