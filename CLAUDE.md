# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Layout

A monorepo with two sibling packages plus a compose file that ties them together:

- `frontend/` — Vite + React + TypeScript SPA (the Pyodide/pandas runtime lives here).
- `backend/` — FastAPI service (recipe generation proxy + persistence). **Never executes user code.**
- `docker-compose.yml` — full stack: frontend `:8080` (nginx) + backend `:8000` + postgres.

Each package has a `Makefile` with a `dev-local` target for running outside Docker.

## Commands

Frontend (run from `frontend/`):

```sh
cd frontend
npm install
make dev-local   # == npm run dev — Vite dev server at http://localhost:5173 (proxies /api -> :8000)
npm run build    # tsc type-check (noEmit) THEN vite build to dist/ — the type gate
npm run preview  # serve the production build
npm test         # Vitest (happy-dom) — unit + component tests in src/**/*.test.{ts,tsx}
```

Backend (run from `backend/`):

```sh
# one-time venv (get-pip because the box lacks ensurepip/system pip)
python3 -m venv --without-pip .venv && curl -fsSL https://bootstrap.pypa.io/get-pip.py | .venv/bin/python
.venv/bin/pip install -r requirements-dev.txt

cd backend
./.venv/bin/python -m pytest        # tests in backend/tests/
make dev-local                      # uvicorn --reload on :8000 (sqlite, live Bedrock via host AWS SSO, dev auth codes)
```

Full stack: `docker compose up --build` (app at http://localhost:8080). The backend container has no
AWS creds and no mailer, so set `MOCK_GENERATE=1` (canned recipe) and `AUTH_DEV_ECHO=1` (echo login
codes) via a `docker-compose.override.yml` for a self-contained local run — see the run notes below.

`npm run build` is the type gate — `tsconfig.json` enables `strict`, `noUnusedLocals`, and
`noUnusedParameters`, so unused imports/vars are hard errors (test files are excluded via `tsconfig.json`
`exclude`). No linter/formatter is configured. **Node 18** on this box: some newer deps assume Node 20 —
that's why tests use happy-dom (not jsdom) and why a clean `frontend/node_modules` matters.

## Big picture

Plain-language descriptions become deterministic pandas scripts ("recipes") that run **in the browser**.
The backend generates recipe *text* (via Claude on Bedrock) and stores it; it never runs user code.
Accounts are optional (anonymous-first). The data flow spans both packages:

1. **File in** → `App.handleFiles` → `pyWorker.loadInput`, which runs pandas `read_csv`/`read_excel` in
   the web worker and returns a `TablePreview`. Files never leave the browser.
2. **Prompt** → `App.generate` → `generateRecipe` (`frontend/src/lib/api.ts`) streams the chat history +
   dataset schema to `POST /generate`. The backend (`backend/app/generate.py`) calls Claude on Bedrock and
   streams back a plain-language explanation, exactly one `python` code block defining
   `transform(inputs, params)`, and one `json` block describing adjustable **knobs**. `extract_script` /
   `extract_params` pull those out of the last blocks.
3. **Run** → `App.runScript` → `pyWorker.runScript` `exec`s the script, calls `transform(inputs, params)`,
   and returns `{tables, plots}`. Plot figures are plain Plotly dicts built in Python and rendered by
   Plotly.js on the main thread (`frontend/src/lib/plot.ts`) — Plotly is **not** installed in Pyodide.
4. **Save** → `POST /recipes` (`backend/app/recipes.py`) persists + versions the recipe (owner-scoped).
   `buildRecipe` (`frontend/src/lib/recipe.ts`) can also download a standalone `.py`; `parseRecipe`
   re-applies a dropped `.py`.

### Two execution boundaries — respect them

- **Python runs only in the web worker** (`frontend/src/lib/pyodideWorker.ts`), never on the UI thread.
  The worker owns the single Pyodide instance; its `BOOTSTRAP` string holds all Python entry points
  (`load_input`, `run_script`, `export_table`, `rename_input`), each returning a JSON string with an `ok`
  flag so tracebacks surface as readable errors. Input/output DataFrames live in the worker's `_state`
  dict — the UI only ever sees serialized previews. `frontend/src/lib/pyodide.ts` is the typed RPC bridge
  (`pyWorker` singleton); add a capability by extending `WorkerRequest` + a `BOOTSTRAP` fn + a dispatch
  branch + a `PyWorker` method.
- **The backend never executes user code** — it only generates recipe text and stores it. This is a
  deliberate security boundary; don't add a code-execution path server-side.

### Conventions worth knowing

- **v2 recipe contract:** `transform(inputs: dict[str, DataFrame], params: dict) -> {"tables": {...},
  "plots": {...}}` — 1+ tables, 0+ Plotly figure dicts. `plot_bar/plot_line/plot_scatter/plot_pie` helpers
  are injected into the recipe namespace (dependency-free — they return Plotly dicts; don't import plotly).
- **Knobs** are inferred by the model: it reads adjustable scalars via `params.get("key", DEFAULT)` and
  emits a `json` spec (name/label/type/default/…) that the UI renders as controls. Last-used values are
  persisted alongside the recipe and restored on reopen.
- **LLM contract** lives in `SYSTEM_PROMPT` in `backend/app/generate.py`. Generation uses **boto3
  `bedrock-runtime` Converse** (streaming) — *not* the anthropic SDK, whose Bedrock clients fail in this
  account. `BEDROCK_MODEL` defaults to `us.anthropic.claude-opus-4-6-v1`; `MOCK_GENERATE=1` returns a
  canned recipe for offline/dev.
- **Auth is passwordless + optional** (`backend/app/auth.py`): email → 6-digit code. The `anon_id` cookie
  *is* the session (`backend/app/owner.py`); signing in links it to a `User` and **claims** the session's
  anonymous recipes. A recipe is owned by *either* an anon session or a user (`owner.py` resolves a
  `Principal`; `recipes.py` scopes every route through it). `_send_code` just logs today; `AUTH_DEV_ECHO=1`
  returns the code in the response for local use — wire a real mailer (e.g. SES) for prod.
- **Persistence:** SQLAlchemy 2.0; sqlite `backend/data/app.db` by default, Postgres via compose
  (`DATABASE_URL`). Recipe versions are immutable snapshots (script + params + param_values + inputs).
- **Product name is centralized** in `frontend/src/branding.ts` (`APP_NAME`, `APP_TAGLINE`) — never add a
  second copy. **UI state is all in `frontend/src/App.tsx`** via `useState`; no store/router/context.
- **Recipe file format** (`frontend/src/lib/recipe.ts`): a `# === recipe metadata ===` JSON-in-comments
  header, the `transform()` body, then an `if __name__ == "__main__"` argparse CLI so the file also runs
  standalone (`python recipe.py orders.csv -o out.csv`). Metadata delimiters + main guard are the parse
  anchors — keep build/parse in sync.

### TypeScript notes

- The worker deliberately avoids the WebWorker lib types (they conflict with DOM types in a single
  `tsconfig`); it casts `self` to a minimal typed shape instead. Pyodide is typed `any`.
- Vite is configured for ES-module workers (`worker.format: "es"`); the Pyodide URL import uses
  `/* @vite-ignore */` so Vite doesn't try to bundle the CDN module.
