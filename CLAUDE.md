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
2. **Prompt** → an **agent loop** owned by the frontend (`frontend/src/lib/agent.ts`, driven from
   `App.driveAgent`). `POST /generate` (`backend/app/generate.py`) is a *stateless per-turn oracle*: one
   Bedrock Converse call with tool use that returns either tool calls to run or a final recipe. The tools
   (`preview_rows`, `column_profile`, `run_recipe`, `ask_user`, `submit_recipe`) execute in the Pyodide
   worker; `run_recipe` lets the model **test its draft on the real data and fix errors before submitting**.
   The frontend runs each tool, appends results to the transcript, and re-posts until `submit_recipe`
   (final) or `ask_user` (a clarifying question). Data-value tools are gated by the user's data-access
   toggle. See docs/agent-harness-design.md.
3. **Run** → `App.runScript` → `pyWorker.runScript` `exec`s the script, calls `transform(inputs, params)`,
   and returns `{tables, plots}`. Plot figures are plain Plotly dicts built in Python and rendered by
   Plotly.js on the main thread (`frontend/src/lib/plot.ts`) — Plotly is **not** installed in Pyodide.
4. **Save** → `POST /recipes` (`backend/app/recipes.py`) persists + versions the recipe (owner-scoped).
   `buildRecipe` (`frontend/src/lib/recipe.ts`) can also download a standalone `.py`; `parseRecipe`
   re-applies a dropped `.py`.

### Two execution boundaries — respect them

- **Python runs only in the web worker** (`frontend/src/lib/pyodideWorker.ts`), never on the UI thread.
  The worker owns the single Pyodide instance; its `BOOTSTRAP` string holds all Python entry points
  (`load_input`, `run_script`, `export_table`, `rename_input`, and the agent tools `preview_rows`,
  `column_profile`, `run_recipe_test`), each returning a JSON string with an `ok` flag so tracebacks
  surface as readable errors. Agent-tool calls resolve with their full result (including `{ok:false}`
  errors) so the loop can feed a traceback back to the model. Input/output DataFrames live in the worker's `_state`
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
  returns a spec (name/label/type/default/…) in the `submit_recipe` tool call, which the UI renders as
  controls. Last-used values are persisted alongside the recipe and restored on reopen.
- **Agent contract** lives in `SYSTEM_PROMPT` + the tool specs in `backend/app/generate.py`. Generation
  uses **boto3 `bedrock-runtime` Converse tool use** (streaming) — *not* the anthropic SDK, whose Bedrock
  clients fail in this account. The transcript is a neutral shape (`_to_converse` translates it); each turn
  returns a typed SSE terminal (`tool_use` / `final` / `question` / `message` / `error`). Converse requires
  alternating roles and paired tool_use/tool_result, so the frontend records a *final* as a plain assistant
  turn (never a dangling `submit_recipe` call). `BEDROCK_MODEL` defaults to
  `us.anthropic.claude-opus-4-6-v1`; `MOCK_GENERATE=1` returns a canned recipe for offline/dev.
- **Auth is passwordless + optional** (`backend/app/auth.py`): email → 6-digit code. The `anon_id` cookie
  *is* the session (`backend/app/owner.py`); signing in links it to a `User` and **claims** the session's
  anonymous recipes. A recipe is owned by *either* an anon session or a user (`owner.py` resolves a
  `Principal`; `recipes.py` scopes every route through it). `_send_code` just logs today; `AUTH_DEV_ECHO=1`
  returns the code in the response for local use — wire a real mailer (e.g. SES) for prod.
- **Persistence:** SQLAlchemy 2.0; sqlite `backend/data/app.db` by default, Postgres via compose
  (`DATABASE_URL`). Recipe versions are immutable snapshots (script + params + param_values + inputs).
- **Sharing:** a recipe can have an unguessable `share_token` (`POST/DELETE /recipes/{id}/share`).
  `GET /recipes/shared/{token}` is **public** (no auth) and returns only the recipe *text* (script +
  expected columns + knob defaults) — never any data or owner identity. Since execution is client-side,
  sharing a link shares only the transformation; the recipient runs it on their own files locally.
- **Apply vs. author:** `frontend/src/components/ApplyView.tsx` is the focused "run a recipe" screen
  (named drop-slots per input, knobs, output, "save a copy"). It's used both for a shared link
  (`/s/{token}`, detected on mount) and when opening your own recipe from the library; **Edit** hands off
  to the authoring workspace. The authoring workspace (describe → agent → save) is the other mode.
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
