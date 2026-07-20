"""DataRecipes server-side LLM proxy.

This service is the server-side proxy that (in slice #2) will call Claude on
Amazon Bedrock via the ``anthropic`` SDK's
``AnthropicBedrockMantle(aws_region="us-east-2")`` client.

Planned model routing:
  - Generation:  ``us.anthropic.claude-opus-4-8``
  - Cheap path:  ``us.anthropic.claude-haiku-4-5-20251001-v1:0``

Responses will be streamed to the client via Server-Sent Events (SSE).
For now ``POST /generate`` is a clearly-marked stub; no Bedrock call is made.
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="DataRecipes LLM Proxy")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:8080"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class InputSpec(BaseModel):
    alias: str
    columns: list[str]
    dtypes: list[str]


class Message(BaseModel):
    role: str
    text: str


class GenerateRequest(BaseModel):
    inputs: list[InputSpec] = []
    params: dict[str, Any] = {}
    messages: list[Message] = []


class GenerateResponse(BaseModel):
    text: str
    script: str | None = None


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/generate", response_model=GenerateResponse)
def generate(req: GenerateRequest) -> GenerateResponse:
    # TODO(slice-2): call Bedrock
    # Instantiate AnthropicBedrockMantle(aws_region="us-east-2") and stream a
    # response from us.anthropic.claude-opus-4-8 (or the haiku cheap path) over
    # SSE. For now return a static stub so the frontend can integrate.
    return GenerateResponse(text="stub response — Bedrock not wired up yet", script=None)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("app.main:app", host="0.0.0.0", port=port)
