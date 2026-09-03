# Abracadata

> **Describe your spreadsheet work once. Rerun it forever — like magic.** (The product name lives in [`frontend/src/branding.ts`](frontend/src/branding.ts).)

Turn plain-language descriptions into **reusable data-transformation scripts**. Drop one or more CSV/Excel files, describe what you need — join, clean, summarize, chart — and the AI writes a deterministic script that runs instantly in your browser. Save it as a **recipe** and re-run it on next month's files: same steps, same result, no re-prompting.

**Radically simple by design:** anonymous by default, no connectors, no projects. Your file data never leaves the browser.

## How it works

1. **Drop your files** — CSV/XLSX is parsed in your browser (Papa Parse / SheetJS) inside a web worker. File contents never leave your machine.
2. **Describe what you need** — only the column schema (and, optionally, sample rows) is sent to the backend, which asks Claude (on Amazon Bedrock) to generate a JavaScript `transform(inputs, params)` recipe (using the [Arquero](https://uwdata.github.io/arquero/) dataframe library) plus a set of adjustable **knobs**.
3. **See the result** — the recipe runs locally in the web worker; you get output tables and native Plotly charts. Tune the knobs and it re-runs instantly. Edit the code directly if you like.
4. **Save & reuse** — recipes are saved and versioned server-side (text only, never your data). Next month, open a recipe and drop your new files — they're matched to the recipe's named slots by schema and it re-runs. You can also download the recipe as a `.js` file.

**Accounts are optional.** Everything works anonymously (tied to a browser cookie). Sign in — passwordless, via an emailed code — to keep your recipes and reach them from any device; your anonymous recipes are claimed into the account on first sign-in.

## Repository layout

| Package | What |
|---|---|
| [`frontend/`](frontend/) | Vite + React + TypeScript SPA. In-browser recipe runtime (Arquero), Plotly rendering, all UI. |
| [`backend/`](backend/) | FastAPI: recipe generation proxy (Claude on Bedrock) + persistence. Never executes user code. |
| [`docker-compose.yml`](docker-compose.yml) | Full stack: frontend `:8080` (nginx) + backend `:8000` + postgres. |

## Development

Run the two packages in separate terminals (each has a `Makefile`):

```sh
# backend — API on :8000 (sqlite, live Bedrock via host AWS creds, dev auth codes)
cd backend && make dev-local

# frontend — Vite on :5173, proxies /api -> :8000
cd frontend && make dev-local
```

Or the whole stack in Docker: `docker compose up --build` (app at http://localhost:8080). The backend
container has no AWS credentials or mailer, so for a self-contained local run add a `docker-compose.override.yml`:

```yaml
services:
  backend:
    environment:
      MOCK_GENERATE: "1"   # canned recipe instead of live Bedrock; or mount ~/.aws for real generation
      AUTH_DEV_ECHO: "1"   # show the login code in the sign-in dialog
```

The data engine (Arquero + Papa Parse + SheetJS) is bundled into a web-worker chunk, loaded on first use — no heavy runtime download.

### Secret scanning (pre-commit)

A [gitleaks](https://github.com/gitleaks/gitleaks) pre-commit hook blocks commits that contain
secrets. Enable it once per clone:

```sh
git config core.hooksPath .githooks
# install the scanner (or the hook falls back to the gitleaks Docker image):
#   https://github.com/gitleaks/gitleaks/releases   (or `brew install gitleaks`)
```

The hook scans only the staged diff. To sweep full history: `gitleaks git`. Rules and allowlists
live in `.gitleaks.toml`.

Two complementary layers run both locally (pre-commit) and in CI:

| Check | Catches |
|---|---|
| **gitleaks** | secrets by *content* — AWS keys, tokens, PEM blocks — across all history |
| **`scripts/check-forbidden-files.sh`** | files dangerous by *type* — `.tfstate`, `.env`, private keys, DB dumps — which pattern scanners miss (`*.example` is allowed) |

The repo is public, so GitHub's own **secret scanning + push protection** are enabled too; they block a
push containing a recognized provider secret and notify the provider to revoke it.

## Architecture

| Piece | Where |
|---|---|
| Recipe runtime + file parsing (web worker) | `frontend/src/lib/jsWorker.ts`, `recipeRuntime.ts` |
| Worker RPC bridge | `frontend/src/lib/worker.ts` |
| Plotly rendering (figures built as dicts by the recipe) | `frontend/src/lib/plot.ts` |
| Backend API client (generate + recipe CRUD + auth) | `frontend/src/lib/api.ts` |
| Recipe `.js` build/parse | `frontend/src/lib/recipe.ts` |
| UI | `frontend/src/App.tsx` + `frontend/src/components/` |
| Recipe generation (Claude on Bedrock, boto3 Converse) | `backend/app/generate.py` |
| Persistence + versioning | `backend/app/recipes.py`, `backend/app/models.py` |
| Passwordless auth + ownership | `backend/app/auth.py`, `backend/app/owner.py` |

## Renaming the product

Set `APP_NAME` and `APP_TAGLINE` in `frontend/src/branding.ts`, update `name` in `frontend/package.json`, and replace the title of this README. Nothing else references the name.

## License

[MIT](LICENSE)
