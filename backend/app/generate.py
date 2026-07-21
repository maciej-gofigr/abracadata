"""Recipe generation via Claude on Amazon Bedrock (boto3 Converse, streaming).

The anthropic SDK's Bedrock clients don't work in this account (the Mantle
endpoint 404s; the InvokeModel path is use-case-gated), so we call the
bedrock-runtime Converse API directly with boto3. Model access is also narrower
than the model listing — ``us.anthropic.claude-opus-4-6-v1`` is the best
Opus tier this account can reach today (override via BEDROCK_MODEL).

This endpoint generates recipe *scripts*; it never executes them.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Iterator

import boto3
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

router = APIRouter()

AWS_REGION = os.environ.get("AWS_REGION", "us-east-2")
BEDROCK_MODEL = os.environ.get("BEDROCK_MODEL", "us.anthropic.claude-opus-4-6-v1")

_bedrock = boto3.client("bedrock-runtime", region_name=AWS_REGION)

SYSTEM_PROMPT = """You are the code generator inside a data-transformation tool for non-technical office workers. The user has loaded one or more tabular files (each a pandas DataFrame) and describes what they want in plain language.

Respond with a short plain-language explanation of what the recipe does (1-3 sentences, no jargon), then exactly one Python code block containing the complete script, then one JSON code block describing the adjustable settings (details below).

Requirements for the script:
- Define: def transform(inputs: dict, params: dict) -> dict
- `inputs` is keyed by the aliases listed in the message (e.g. inputs["orders"]). `params` holds adjustable values the user can tweak later.
- Return {"tables": {name: DataFrame, ...}, "plots": {name: figure, ...}} — 1 or more tables, 0 or more plots. Names are short, human-readable strings.
- For charts, call these helpers (already in scope — do NOT import or redefine them, and do NOT import plotly):
    plot_bar(x, y, title=None, xlabel=None, ylabel=None)
    plot_line(x, y, title=None, xlabel=None, ylabel=None)
    plot_scatter(x, y, title=None, xlabel=None, ylabel=None)
    plot_pie(labels, values, title=None)
  They return Plotly figure dicts.
- Use only pandas, numpy, and the Python standard library. No file or network I/O — operate only on the DataFrames in `inputs`.
- Be robust to messy real-world data (strip whitespace when matching strings, coerce types when needed), but never silently drop data unless the user asked for a filter.
- When revising a previous script, return the full updated script, not a diff.
- Put `import pandas as pd` at the top.

Adjustable settings (knobs):
- Identify simple scalar values a non-technical user might reasonably want to change later WITHOUT re-describing the recipe: thresholds, a group-by column, a top-N count, a date cutoff, an on/off toggle. Prefer 0-4 of the most useful; do not invent knobs that aren't central to the request.
- In the script, read each knob from `params` using `params.get("key", DEFAULT)` where DEFAULT is the value you'd otherwise hardcode, and reference that same key consistently. Using `.get` with a default means the recipe still runs if a value is absent.
- After the Python code block, output ONE fenced code block tagged `json` containing a JSON array describing those knobs, so the tool can render them as controls. Each entry is an object:
    {"name": the exact params key, "label": short human label, "type": "number"|"currency"|"date"|"enum"|"bool"|"text", "default": the default value}
  Optional per entry: "options" (array of strings, REQUIRED for "enum"), "min"/"max"/"step" (for number/currency), "help" (a short hint, no jargon).
  Use "currency" for money amounts and "enum" (with "options") when the value must be one of a fixed set such as a column name to group by. Every knob's "name" MUST be a key the script reads from params. If there are no sensible knobs, output an empty array: []."""


class InputSpec(BaseModel):
    alias: str
    columns: list[str] = []
    dtypes: list[str] = []


class Message(BaseModel):
    role: str
    text: str


class GenerateRequest(BaseModel):
    inputs: list[InputSpec] = []
    params: dict[str, Any] = {}
    messages: list[Message] = []


def _dataset_context(inputs: list[InputSpec], params: dict[str, Any]) -> str:
    lines = [
        "The user has loaded these input tables (reference them by alias inside transform(inputs, params)):",
    ]
    for inp in inputs:
        cols = ", ".join(
            f"{c} ({t})" for c, t in zip(inp.columns, inp.dtypes or [""] * len(inp.columns))
        )
        lines.append(f'- inputs["{inp.alias}"]: {cols}')
    if params:
        lines.append("Current parameters (the params dict): " + json.dumps(params))
    return "\n".join(lines)


def _build_messages(req: GenerateRequest) -> list[dict[str, Any]]:
    ctx = _dataset_context(req.inputs, req.params)
    out: list[dict[str, Any]] = []
    for i, m in enumerate(req.messages):
        text = m.text
        if i == 0 and m.role == "user" and (req.inputs or req.params):
            text = f"{ctx}\n\nUser request: {m.text}"
        out.append({"role": m.role, "content": [{"text": text}]})
    return out


def _code_blocks(text: str) -> list[tuple[str, str]]:
    """All fenced blocks as (lang, body); lang is "" for untagged fences."""
    return [
        (lang.lower(), body)
        for lang, body in re.findall(r"```([A-Za-z0-9_+-]*)[ \t]*\n(.*?)```", text, re.DOTALL)
    ]


def extract_script(text: str) -> str | None:
    blocks = _code_blocks(text)
    # Prefer the last python/untagged block that actually defines transform,
    # so a trailing ```json knob block is never mistaken for the script.
    for lang, body in reversed(blocks):
        if lang in ("", "python", "py") and "def transform" in body:
            return body.strip()
    for lang, body in reversed(blocks):
        if lang in ("", "python", "py"):
            return body.strip()
    return None


_ALLOWED_PARAM_TYPES = {"number", "currency", "date", "enum", "bool", "text"}


def _sanitize_params(data: Any) -> list[dict[str, Any]]:
    """Keep only well-formed knob specs matching the frontend RecipeParam shape."""
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
            continue  # an enum with no options can't render a control
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
        if len(out) >= 8:  # cap the number of controls
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


def _stream_deltas(system: str, messages: list[dict[str, Any]]) -> Iterator[str]:
    resp = _bedrock.converse_stream(
        modelId=BEDROCK_MODEL,
        system=[{"text": system}],
        messages=messages,
        inferenceConfig={"maxTokens": 4096},
    )
    for event in resp["stream"]:
        delta = event.get("contentBlockDelta", {}).get("delta", {})
        if "text" in delta:
            yield delta["text"]


# A canned recipe for MOCK_GENERATE=1 — lets the frontend/integration be
# exercised without a live Bedrock call (e.g. offline dev, or while account
# model-access is being provisioned). Never used unless the env var is set.
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

_MOCK_PARAMS = (
    '[{"name": "min_amount", "label": "Minimum order amount", "type": "currency", '
    '"default": 0, "min": 0, "step": 50, "help": "Orders below this are dropped"}]'
)


@router.post("/generate")
def generate(req: GenerateRequest) -> StreamingResponse:
    if os.environ.get("MOCK_GENERATE"):
        def mock() -> Iterator[str]:
            yield f"data: {json.dumps({'text': 'Here is a recipe that joins your orders to customers and shows revenue share by segment as a pie chart.'})}\n\n"
            block = f"```python\n{_MOCK_RECIPE}\n```\n\n```json\n{_MOCK_PARAMS}\n```"
            yield f"data: {json.dumps({'text': block})}\n\n"
            yield f"data: {json.dumps({'done': True, 'script': extract_script(block), 'params': extract_params(block)})}\n\n"

        return StreamingResponse(mock(), media_type="text/event-stream")

    if not req.messages:
        # nothing to do — return a one-shot SSE error
        def empty() -> Iterator[str]:
            yield f"data: {json.dumps({'error': 'no message provided'})}\n\n"

        return StreamingResponse(empty(), media_type="text/event-stream")

    system = SYSTEM_PROMPT
    messages = _build_messages(req)

    def gen() -> Iterator[str]:
        acc: list[str] = []
        try:
            for delta in _stream_deltas(system, messages):
                acc.append(delta)
                yield f"data: {json.dumps({'text': delta})}\n\n"
        except Exception as exc:  # surface Bedrock/credential errors to the client
            yield f"data: {json.dumps({'error': f'{type(exc).__name__}: {exc}'})}\n\n"
            return
        full = "".join(acc)
        yield f"data: {json.dumps({'done': True, 'script': extract_script(full), 'params': extract_params(full)})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")
