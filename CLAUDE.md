# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Frontend (Vite SPA at repo root):

```sh
npm install
npm run dev      # Vite dev server at http://localhost:5173
npm run build    # tsc type-check (noEmit) THEN vite build to dist/  — the type gate
npm run preview  # serve the production build
npm test         # Vitest (happy-dom) — unit + component tests in src/**/*.test.{ts,tsx}
```

Backend (FastAPI in `backend/`) and full stack:

```sh
# backend tests (venv; get-pip because the box lacks ensurepip/system pip)
python3 -m venv --without-pip backend/.venv && curl -fsSL https://bootstrap.pypa.io/get-pip.py | backend/.venv/bin/python
backend/.venv/bin/pip install -r backend/requirements-dev.txt
cd backend && ./.venv/bin/python -m pytest      # tests in backend/tests/

docker compose up                               # full stack: frontend :8080 (nginx) + backend :8000
```

`npm run build` is the type gate — `tsconfig.json` enables `strict`, `noUnusedLocals`, and
`noUnusedParameters`, so unused imports/vars are hard errors (test files are excluded from
this build via `tsconfig.json` `exclude`). No linter/formatter is configured. **Node 18** on
this box: some newer deps assume Node 20 — that's why tests use happy-dom (not jsdom) and why
a clean `node_modules` matters (see history if `vite`/`rollup` misbehave).

## Big picture

A **fully client-side, serverless** web app: static page, no backend, no accounts, no
persistence beyond `localStorage`. It turns plain-language descriptions into deterministic
pandas scripts ("recipes") that run in-browser. Two external services are hit directly from
the browser: Pyodide/pandas wheels from a CDN, and the Anthropic API with the user's own key.

The data flow that spans multiple files:

1. **File in** → `App.handleFiles` sends the raw bytes to `pyWorker.loadFile`, which runs
   pandas `read_csv`/`read_excel` in the worker and returns a `TablePreview`.
2. **Prompt** → `App.sendPrompt` calls `generateScript` (`src/lib/llm.ts`), which sends the
   chat history + dataset schema to Anthropic and expects a reply containing exactly one
   Python code block defining `transform(df)`. `extractScript` pulls the last code block out.
3. **Run** → `App.runScript` sends the script to `pyWorker.runScript`, which `exec`s it,
   calls `transform(input.copy())`, and returns an output `TablePreview` + `DiffSummary`.
4. **Save** → `buildRecipe` (`src/lib/recipe.ts`) wraps the script in a metadata header +
   CLI entry point and downloads it as a `.py` file. Dropping such a `.py` back in is parsed
   by `parseRecipe` and re-applied to a new file.

### Two execution boundaries — respect them

- **Python runs only in the web worker** (`src/lib/pyodideWorker.ts`), never on the UI
  thread. The worker owns the single Pyodide instance. Its Python `BOOTSTRAP` string holds
  all Python entry points (`load_file`, `run_script`, `export_output`); each returns a JSON
  string with an `ok` flag so Python tracebacks surface as readable errors rather than opaque
  JS throws. DataFrame state (`input`/`output`) lives in the worker's `_state` dict — the UI
  only ever sees serialized previews, never the DataFrame itself.
- **`src/lib/pyodide.ts`** is the typed RPC bridge (`pyWorker` singleton): correlates
  request/response by incrementing `id`, wraps each call in a promise. Add a new Python
  capability by extending `WorkerRequest`, adding a `BOOTSTRAP` function + dispatch branch in
  the worker, and a method on `PyWorker`.

### Conventions worth knowing

- **Product name is centralized** in `src/branding.ts` (`APP_NAME`, `APP_TAGLINE`). Nothing
  else hardcodes the name — never introduce a second copy. "Data Recipes" is a working title.
- **LLM contract** lives in `SYSTEM_PROMPT` in `src/lib/llm.ts`: script must define
  `transform(df: pd.DataFrame) -> pd.DataFrame`, use only pandas/numpy/stdlib, no file or
  network I/O, and return the *full* updated script on revisions (not a diff). Dataset context
  (schema + optionally first 20 rows, gated by `settings.shareSampleRows`) is attached to the
  first user turn only; the chat resets whenever a new file loads so the context stays valid.
- **`DEFAULT_MODEL`** (`claude-opus-4-8`) is set in `src/lib/llm.ts`. The SDK is called with
  `dangerouslyAllowBrowser: true` because the key is the user's own, kept in `localStorage`.
- **Recipe file format** (`src/lib/recipe.ts`): a `# === recipe metadata ===` JSON-in-comments
  header, the `transform()` body, then an `if __name__ == "__main__"` argparse CLI so the same
  file also runs standalone (`python recipe.py input.csv -o output.csv`). Keep build/parse in
  sync — the metadata delimiters and main guard are the parse anchors.
- **State is all in `App.tsx`** via `useState` — there is no store/router/context. `Settings`
  is the only thing persisted (`localStorage` key `settings.v1`).

### TypeScript notes

- The worker deliberately avoids the WebWorker lib types (they conflict with DOM types in a
  single `tsconfig`); it casts `self` to a minimal typed shape instead. Pyodide is typed `any`.
- Vite is configured for ES-module workers (`worker.format: "es"`); the Pyodide URL import
  uses `/* @vite-ignore */` so Vite doesn't try to bundle the CDN module.
