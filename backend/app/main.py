"""DataRecipes backend.

A thin service that never executes user-generated code. Responsibilities:
  - /generate : proxy recipe generation to Claude on Amazon Bedrock (app.generate)
  - /recipes  : save / version / share recipes (app.recipes) — text + metadata only
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.auth import router as auth_router
from app.db import init_db
from app.generate import router as generate_router
from app.recipes import router as recipes_router


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="DataRecipes API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:8080"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(auth_router)
app.include_router(generate_router)
app.include_router(recipes_router)
