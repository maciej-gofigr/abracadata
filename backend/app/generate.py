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

Respond with a short plain-language explanation of what the recipe does (1-3 sentences, no jargon), then exactly one Python code block containing the complete script.

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
- Put `import pandas as pd` at the top."""


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


def extract_script(text: str) -> str | None:
    blocks = re.findall(r"```(?:python)?\s*\n(.*?)```", text, re.DOTALL)
    return blocks[-1].strip() if blocks else None


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
    summary = (df.groupby("Segment", as_index=False)
                 .agg(Orders=("Order ID", "count"), **{"Total Revenue": ("Amount", "sum")})
                 .sort_values("Total Revenue", ascending=False))
    chart = plot_pie(summary["Segment"], summary["Total Revenue"], title="Revenue share by segment")
    return {"tables": {"By segment": summary}, "plots": {"Revenue by segment": chart}}'''


@router.post("/generate")
def generate(req: GenerateRequest) -> StreamingResponse:
    if os.environ.get("MOCK_GENERATE"):
        def mock() -> Iterator[str]:
            yield f"data: {json.dumps({'text': 'Here is a recipe that joins your orders to customers and shows revenue share by segment as a pie chart.'})}\n\n"
            block = f"```python\n{_MOCK_RECIPE}\n```"
            yield f"data: {json.dumps({'text': block})}\n\n"
            yield f"data: {json.dumps({'done': True, 'script': extract_script(block)})}\n\n"

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
        yield f"data: {json.dumps({'done': True, 'script': extract_script(full)})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")
