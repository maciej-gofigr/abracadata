# Data Recipes — Product Requirements (v1)

> Working title. Product name plugs in via `src/branding.ts`.
> Author: acting product/business owner. Status: proposed direction for review.

## 0. The one-sentence thesis

**Data Recipes turns the spreadsheet chore you rebuild every month into a reusable recipe you describe once in plain English and re-run forever — same steps, same result, no formulas, no analyst, no waiting.**

The magic is *determinism*: an AI writes the recipe, but the recipe — not the AI — runs your data, so next month's file gets the exact same treatment. That is the wedge against "just ask ChatGPT to clean my CSV," which silently re-reasons and drifts every time.

The current MVP proves the core loop but has three adoption-killers for a non-technical audience, all of which this doc removes:
1. **Bring-your-own API key** → replaced by a server-side LLM proxy (we pay, metered).
2. **localStorage / download-only persistence** → replaced by cloud recipe library with optional login.
3. **No accounts, no sharing, no re-run ergonomics** → replaced by anonymous-first accounts, sharing, and a template gallery.

What we deliberately keep: **client-side execution via Pyodide.** "Your data never leaves your browser" is a genuine, rare privacy moat — we preserve it as the default and make server-side execution an explicit, premium-only opt-in.

---

## 1. Ideal Customer Profile

The atomic unit we automate: **a file with the same shape arrives on a schedule, and the same manual surgery gets performed on it every time.**

### Primary — lead here: the Finance/Ops "monthly close" analyst
*Rachel, 34, FP&A at a 200-person company.* Every month she exports the same Stripe dump, payroll CSV, and bank statement and reshapes each into her board-deck format: strip test transactions, map GL codes via VLOOKUP against a reference tab, pivot by cost center, reconcile against last month. 4–6 hours per file, forever, on a brittle master workbook that breaks when an upstream column is renamed. She doesn't code but *thinks in transformations*. She sits next to a budget holder and already pays for tools.

**Why she's the wedge:** the pain is scheduled and identical (where "record once, re-run forever" is 10× a one-shot prompt); she quantifies ROI in dollars ("saves me a day a month"); and finance specifically *trusts deterministic, auditable output* over "the AI eyeballed my numbers."

### Secondary — the Marketing/RevOps data janitor
*Devin, 29.* Merges lead lists from webinars, LinkedIn, CRM; dedupes on fuzzy email/company, normalizes inconsistent country/title strings, filters to ICP, formats for SDR upload. Re-derives the steps from scratch every campaign because he never wrote them down.

### Tertiary — the small-business owner / office admin
*Maria, 48, ops for a 3-location dental practice.* Categorizes billing/remittance CSVs by provider, flags underpayments, by hand, at night. No analyst, no IT, no budget. High-pain, high-gratitude, the purest test of "frictionless."

**Lead-in use case for GTM:** "Automate the spreadsheet you rebuild every month," aimed at the finance/ops persona. Everything about one-off analysis is a distraction from this.

### Competitive position
- **Excel/Sheets + Power Query** — the real incumbent; already reusable + deterministic. We win on *authoring* (one plain sentence vs. M-language/GUI step-hell non-technical users never master) and speed-to-first-recipe. We lose on ubiquity/zero switching cost.
- **"Ask ChatGPT/Claude to analyze my CSV"** — the closest emotional substitute; wins on discovery. Loses decisively on **determinism and repeatability**. Our entire product is the answer to "don't be creative, do the exact same thing again."
- **Parabola** — strongest structural competitor (visual ops/finance automation, scheduling, free tier + ~$20/mo). We win on *mental-model simplicity* (a file + a sentence vs. a canvas of cards).
- **Rows / Gigasheet / OpenRefine / Bardeen** — adjacent (spreadsheets, big-file analysis, or SaaS-action automation), different job. We're a *transformation recorder*, not a spreadsheet.

**Defensibility:** the tech is copyable; the accumulated **recipe library** (switching cost compounds monthly) and a shared **template gallery** (network effect + SEO) are not. Invest in sharing and the gallery early — they are the moat, not the model.

---

## 2. Backend, Auth & Persistence

### 2.1 Auth — "optional login" via anonymous-session-first
Every visitor gets an **anonymous workspace on first load** (server-issued, signed, HTTP-only cookie carrying an opaque `anon_session_id`, server-persisted). That ID owns recipes/runs/usage immediately — the user drops a file, describes a transform, and their recipe is already saved to the cloud, no account required.

**Claim-on-signup migration:** because anonymous work lives server-side from the start (not in localStorage), claiming an account is a transactional **foreign-key re-parent** (`owner_anon_session_id → owner_user_id`), not a data upload — robust and instant. Merge (don't clobber) if the user already had recipes; only allow claiming an unclaimed session.

**Methods, optimized for non-technical users:** magic-link email (passwordless — no reset-password support burden) and **Google + Microsoft OAuth** (this audience lives in Workspace / M365). **Not doing:** mandatory signup wall, password auth, SMS/OTP, BYO-API-key, enterprise SSO in v1. Anonymous cookie TTL ~90 days so returning users keep their work.

**The signup prompt appears only when the user reaches for persistence/portability** — Save recipe, Schedule, Share, or use-on-another-device — never before the first "aha." Let them download one cleaned result without an account so the first payoff is unconditional.

### 2.2 The LLM key problem — server-side proxy, metered
The company holds one Anthropic key server-side; the browser never sees it. A `/generate` endpoint takes `{schema_metadata, prompt, history}`, calls Claude, and **streams** the pandas script back via SSE.

**Metering & cost control (this is the #1 financial risk — see §6):**
- **Meter every request** against `user_id` or `anon_session_id`; track generations/day + input/output tokens. Quota check *before* the model call.
- **Model routing by complexity:** simple asks (rename, filter, sum, name-a-recipe) → `claude-haiku-4-5` ($1/$5 per MTok); complex multi-step transforms → `claude-opus-4-8` ($5/$25). A cheap heuristic/classifier (prompt length, keyword signals) picks the tier. Use adaptive thinking (`thinking: {type:"adaptive"}`) with `output_config.effort: "low"` for straightforward generations.
- **Prompt caching** on the large, stable system prompt (`cache_control` breakpoint) so repeat calls pay ~0.1× on that prefix.
- **Prompt-size caps** — only column schema + optional sample rows go to the model, never full files; this naturally bounds tokens.
- **Rate limits** — per-IP + per-session token buckets at the edge; global concurrency cap; alert on token-spend anomalies.
- **Abuse defense on the anonymous free tier** (the real attack surface): keep the anon quota small, add an invisible CAPTCHA / proof-of-work on anon generation bursts, sign the anon cookie, cap concurrent SSE streams. Require signup to raise limits.

### 2.3 Persistence & data model (Postgres)
- **users** (id, email, auth_provider, created_at)
- **anon_sessions** (id, cookie_hash, claimed_by_user_id, created_at, last_seen)
- **recipes** (id, owner_user_id?, owner_anon_session_id?, name, current_version_id, created_at) — exactly one owner non-null
- **recipe_versions** (id, recipe_id, version_no, prompt_text, generated_script, format_version, inputs_json `[{slug, alias, schema, fingerprint}]` — one **named slot** per input, params_json `[{name, label, type, default, control, …}]` — inferred adjustable knobs, outputs_json `{tables:[…], plots:[…]}`, model_used, created_at) — recipes are immutable-versioned; editing forks a version. `inputs_json` is a **list** of slots (multi-file), so re-run can validate every expected input is present and match this month's files to slots by schema
- **runs** may also carry `param_overrides` (this run's non-default parameter values) — metadata only
- **runs** (id, recipe_version_id, actor_id, status, input_count, row_counts_json, plot_count, duration_ms, error, executed_where `client|server`, created_at) — **metadata only, never file contents**
- **shared_links** (id, recipe_id, slug, access `view|run`, expires_at, created_by)
- **teams** (id, name) + **team_members** (team_id, user_id, role); recipes gain optional team_id
- **usage_credits** (owner_id, period, generations_used, tokens_used, plan)

### 2.4 Execution model — HYBRID (the pivotal decision)
- **Client path (default, all tiers):** the generated script runs in-browser via Pyodide. File contents never leave the machine. Covers interactive use, ad-hoc re-runs, files within WASM memory (~≤50–100 MB). This is the privacy moat and it's free compute (great margin).
- **Server path (premium only, explicit opt-in):** runs the same script in a sandboxed, network-isolated, resource-capped server worker. Unlocks scheduling, files too big for the browser, and connector-sourced data. **Requires** file data to transit and briefly reside server-side.

**Boundary rule:** a run goes server-side *only* when it needs scheduling, exceeds the client size limit, or its source is a server connector. The UI makes the switch explicit ("This automation runs on our servers and will process your data in the cloud") so the privacy contract is never silently broken. **Multi-file joins and Plotly plotting both run client-side** (joins in Pyodide, plots rendered by Plotly.js in the browser — see §2.7); neither needs the server path.

### 2.5 File & data privacy
**Default: never persist file contents server-side.** For generation, the browser extracts only **column schema + optionally the first N sample rows** (user can disable sample sharing) and sends *that* to `/generate`. The model sees structure, not the dataset. This preserves "your data never leaves your machine" for the entire default flow. Premium server runs change this and we say so plainly: files are processed in an **ephemeral sandbox and deleted immediately after the run** (or a short, disclosed retention for scheduled jobs); encrypted in transit/at rest; per-tenant isolation; access-logged. Per-feature badge: "processed locally" vs "processed in cloud." Publish a plain-language data-handling page and a GDPR/CCPA export+delete path.

### 2.6 Premium capabilities that require the backend
Scheduled re-runs (cron → server execution against a connector source); connectors (Google Sheets, email-attachment ingestion, Drive/Dropbox/S3); team-shared recipe libraries + roles + audit history; larger files.

### 2.7 Recipe I/O contract — multiple inputs, tables + plots (v2 format)
The recipe is the core artifact; the v2 format generalizes it from "one table in, one table out" to real office work: **join multiple files, produce multiple result tables, and draw charts.**

**Signature:** `transform(inputs: dict[str, pd.DataFrame], params: dict) -> dict`
- **`inputs`** — one DataFrame per uploaded file, keyed by a stable, user-editable **alias** — *not the literal filename* (each Excel sheet can be its own input). This directly enables the single most common manual chore we're not yet serving: **joining/merging files by hand** — the "VLOOKUP across two exports" that office workers rebuild every month. Multi-file input is therefore *core scope (v1)*, not a future nicety.
- **Returns** `{"tables": {name: DataFrame, …}, "plots": {name: figure, …}}` — **1+ tables, 0+ plots**. A bare `DataFrame` return is accepted as shorthand (`→ {"tables": {"result": df}}`) so trivial recipes stay trivial. Existing v1 recipes (`transform(df) -> df`) keep running under a compatibility shim (single input, single table, no plots).

**Input identity across runs — named slots, matched by schema.** A recipe must never depend on filenames: `orders.csv` becomes `orders_august.csv` next month. So each input is a **named slot** — an editable **alias** (defaulted from the filename with date/period tokens stripped: `orders_august.csv` → "Orders"), plus the **column schema** it saw at authoring time. The recipe references the alias (`inputs["Orders"]`). On **re-run**, the app shows **dedicated, labeled drop targets** ("Orders", "Customers"), each hinting its expected columns; dropped files are **auto-assigned to slots primarily by schema match** (column names/types are stable even when the filename isn't), with filename similarity as a tiebreaker. The user can correct any assignment, and a schema mismatch opens the column-mapping helper (§4.4, §6.3). Renaming a slot is a safe refactor — we own code generation, so it re-keys the recipe, and a stable internal slot id backs the schema match so identity survives renames.

**Inferred parameters — knobs, not re-prompts.** The generator hardcodes literals (`Amount > 100`, `keep="first"`, a date cutoff, a status value). It additionally **declares the 1–5 of these a user is likely to change between runs as typed parameters** and references them in code (`params["min_amount"]`, not the bare `100`). The model — not an AST pass — picks them, because only it knows *which* literal carries user intent and deserves a good label + sensible bounds.
- Each param carries `{name, label, type (number|currency|date|enum|bool|text), default, control, min?/max?/options?, help?}` in recipe metadata. **Default = the exact value the model first used**, so behavior is identical until the user changes it.
- The UI renders a small **Parameters** form of labeled controls ("Minimum order amount: $100", "Keep orders from: 2026-06-01", "Group by: Region ▾"). Editing a value **re-runs `transform` client-side in Pyodide with no LLM call** — instant, free, deterministic. This is the point: the most common repeat action (tweak a number) costs zero tokens and zero latency and cannot silently change methodology. It removes generations from the hottest path (reinforces §2.2/§6 cost control) and deepens the determinism/trust story.
- **Bounded by intent, not literals:** lift only what a non-technical user would plausibly adjust; structural constants stay hardcoded; keep the form ≤5 controls. Users can promote any literal to a parameter ("make this adjustable") or demote one. Type→control: number→stepper, currency→money field, date→picker, small enum (a column, or a status value seen in the data)→dropdown, bool→toggle.
- **Standalone synergy:** each param becomes an `argparse` flag in the exported `.py` (`--min-amount 100`) — the recipe is a real typed CLI tool, a clean extension of the recipe-as-CLI format.

**Plots — figure *specs* built in Python, rendered in JS (never Plotly-in-Pyodide).** Each plot is a **Plotly figure dict** (`{"data": [...], "layout": {...}}`) constructed in plain Python — **no `plotly` package installed in Pyodide.** The rationale is exactly the concern the requirement raises:
- A Plotly figure *is* pure JSON, and **Plotly.js is the renderer plotly-python delegates to anyway** — so emitting the spec and rendering in JS is the native path, not a workaround.
- **Flow:** Python builds the spec (pandas columns → lists) and returns it → the worker passes the already-JSON spec to the main thread over the existing channel → the main thread renders with **Plotly.js loaded in the app** (`Plotly.newPlot(el, fig.data, fig.layout, {responsive:true})`).
- **Why not `micropip install plotly`:** the pure-Python Plotly wheel is tens of MB and slow to import; doing it per-session bloats the worker and stalls the first plot. Building a dict costs nothing. Plotly.js is loaded **lazily, only when a recipe emits a plot**, from a **curated custom bundle** (bar · line/scatter · pie · histogram · box · heatmap) to stay lean.
- **Ergonomics for the LLM:** it may write raw figure dicts, or use tiny **dependency-free `plot_*` builders we inject** into the exec namespace (`plot_bar(x, y, title=…)`, `plot_line(…)`, …) that just return dicts. Whatever it uses is also emitted verbatim into the standalone `.py`, so the file stays self-contained.
- **Safety:** figure dicts are data, not code, but the JS side **validates trace/layout keys against a whitelist schema** before handing them to Plotly — never feed arbitrary keys through.
- **Interactivity & export:** Plotly.js gives hover/zoom/pan for free; "Download chart (PNG)" via Plotly.js `toImage`, "Download data" as CSV of the plot's source table.
- **Standalone portability:** the CLI entry writes each table to CSV and, for plots, `plotly.graph_objects.Figure(spec).write_html(...)` when `plotly` is importable, else dumps the spec JSON with a one-line note — graceful either way.

**Privacy is unchanged:** joins *and* plotting run entirely in Pyodide; only column schemas (+ optional samples, now for **every** input file so the model can infer join keys) ever reach the LLM. Figure specs are built from the user's data locally and rendered locally.

---

## 3. Tech Stack

Opinionated primary stack; Python is the right backend call because the domain *is* pandas — recipes are `.py`, and any server-side validation/linting/execution wants the same runtime the recipes target.

| Layer | Choice | Why |
|---|---|---|
| Frontend | **Next.js (App Router)**, migrated from the Vite SPA | One framework covers the marketing site (SEO/SSG), the app shell, and SSE proxying; React 19 components port nearly verbatim |
| Backend | **FastAPI (Python)** | Async-native (holds streaming Anthropic connections, meters token-by-token), Pydantic models, light for a small team; the pandas-adjacent home-field advantage |
| DB | **Postgres via Supabase** (Neon as alt) | Relational data; Supabase bundles Postgres + Auth + storage + RLS in one managed product |
| Auth | **Supabase Auth** (Clerk as alt) | Native anonymous sessions that *link* to a real identity without losing data + magic-link + Google/MS OAuth; issues JWTs FastAPI verifies |
| LLM | **Anthropic server-side**, Python `anthropic` SDK, **streaming**, model routing | `claude-opus-4-8` for generation, `claude-haiku-4-5` for trivial calls; adaptive thinking + `effort`; meter via `response.usage`; prompt-cache the system prompt |
| File storage | **Avoid storing user files** (default). S3/Supabase Storage only for premium server runs / explicit exports | Not storing files is cheaper, simpler, and *is* the privacy differentiator |
| Payments | **Stripe** (Checkout + Billing + metered usage) | Standard; metered billing maps to token metering |
| Hosting | **Vercel** (Next.js) + **Fly.io** or Railway (FastAPI container) | Each platform does what it's best at; containerized Python avoids serverless streaming/timeout limits |
| Analytics / errors | **PostHog** + **Sentry** | Funnel (upload→prompt→recipe saved) + full-stack error tracking |

**Integration seams:** REST for CRUD; **SSE for LLM streaming** (browser → Next.js route handler → FastAPI `/generate`, forwarding the Supabase JWT). Pyodide execution stays entirely client-side — the backend never sees user data, only prompt + schema. Anonymous→auth uses Supabase's anonymous-identity linking so recipes persist across the upgrade. Recipe = self-contained `.py` stored as text in Postgres; client keeps a local copy for offline Pyodide runs; `updated_at`/version drives last-write-wins sync.

**Alternatives considered:** all-JS Next.js + serverless (fastest to ship, but loses the Python/pandas advantage — you pay the split later when server-side validation/execution needs Python anyway); batteries-included Django (great admin, but sync-first request handling fights token-streaming).

**Migration path from the current MVP:** Phase 0 — keep the crown jewels (React 19 components, `pyodideWorker.ts`, the recipe `.py` format). Phase 1 — wrap in Next.js, add the marketing site. Phase 2 — stand up FastAPI, move the key server-side (delete browser-direct `@anthropic-ai/sdk`), add Supabase + cloud persistence. Phase 3 — auth + anonymous→auth linking + Stripe + token metering. Phase 4 — PostHog/Sentry, model routing, rate limits, quotas.

---

## 4. UI Design & Key Features

### 4.0 Voice & naming (messaging)
The product runs **arbitrary pandas across one or more files** — **joining/merging multiple files**, filtering/cleaning, **aggregations** (group-by, totals, counts), **pivots/reshaping** (wide↔long), derived columns, sorting/ranking, reformatting — and can output **charts** (Plotly) alongside tables. Messaging must not silently cap the product at janitorial single-file work; "join", "summarize", and "chart" are as core as "clean".

Two failure modes to avoid:
- **"Clean up your spreadsheet"** — instantly legible, but narrows the product to janitorial work; a user who needs a monthly revenue *summary* won't recognize themselves in it.
- **"Transform your data"** — accurate but jargon; non-technical users don't self-identify with "transformation."

**Principle: name the job, show the range.** Lead with the recurring-work framing ("the spreadsheet you rebuild every month"); wherever we name the operation, use the plain verb triad **clean · summarize · reshape** — "summarize" carries aggregation without jargon, "reshape" carries pivots. Reserve "transform"/"transformation" for the code and the `transform()` function name — never in customer-facing copy.

- ✅ "Say what you need — clean it up, summarize it, reshape it."
- ✅ Suggestion chips must span the range (a clean, a **summarize**, a reshape) — never three cleanups.
- ❌ "Describe the cleanup." / "Describe a transformation."

**Action:** replace `APP_TAGLINE` in `src/branding.ts` (currently "…describe a transformation, keep the script.") with the verb-triad voice, e.g. **"Clean, summarize, and reshape your spreadsheets — once. Reuse the recipe forever."**

### 4.1 The frictionless first-run flow (no signup)
Landing page opens on a live before/after hero (a faux sheet visibly shrinking, a `1,204 → 317 rows` counter ticking down). Primary CTA is a large calm dropzone: **"Drop a CSV or Excel file — free, no account."** Secondary path for the file-shy: **"Try it with sample data →"** (Messy customer list / Duplicate orders / Marketing signups). Either path lands in the workspace in **one click**; within ~3s the user sees *their own messy data, visibly fixed*, before telling us who they are. That is the aha moment. The signup sheet slides up only when they reach for Save / Schedule / Share / use-elsewhere — framed as *"so you never have to do this again,"* Google/Microsoft SSO first. Pre-signup work is preserved and attached to the new account.

### 4.2 Core interaction — describe → preview → apply
Feels like talking to a competent colleague, not commanding a machine.
- **Describe:** one generous input; because non-technical users often don't know what to ask, surface **suggestion chips derived from the actual data**, deliberately spanning the operation range — a clean (duplicate emails → "Remove duplicate customers"), a filter (a `$` column → "Keep only orders over $100"), a **summarize** (repeated customers + a `$` column → "Summarize total revenue by customer"), and a reshape (a date column → "Add a column for the order month"). Inline autocomplete completes phrases with real column names.
- **Preview (staged, not yet applied):** the table shows the transformed view with change highlighting — removed rows ghosted/struck in muted rose *before* they vanish, new/changed cells haloed green, dropped columns collapsed with a restore affordance. Nothing has touched their file.
- **The diff summary is the trust centerpiece,** written for a non-coder: `Rows 1,204 → 317 (887 removed)`, `Columns 8 → 9 (added: order_month)`, plus a plain-language line ("Removed 887 rows that were duplicates or under $100. Added a column for the order month."). Buttons: **Apply** (primary) and **Not quite — refine** (ghost). Applying stacks the step into a vertical timeline the user can reorder/delete; iteration continues conversationally.

### 4.3 Handling "the AI wrote code" for non-technical users
**The default experience never shows code.** The AI's output is presented as a **plain-language step list** ("1. Removed duplicate customers (matched on email). 2. Kept only orders over $100."), each step editable in words. Progressive disclosure: a quiet **"Show the steps ⌄" / Advanced** reveals the generated pandas with syntax highlighting + copy + an "edit code" toggle (behind a soft acknowledgment). Trust is engineered through four guarantees stated in UI language: **(1) preview before apply**, **(2) undo everything** (persistent undo + per-step removal + full version history), **(3) plain-language "what this will do"** before anything destructive, **(4) original is sacred** — we always transform a copy; a visible "Original file untouched" chip sits near Download. Determinism is sold as a feature: "Same steps, same result, every month — no surprises."

### 4.4 Key screens
- **Landing/marketing** — animated before/after hero, dropzone + sample-data CTA, three-step "Drop → Describe → Reuse," template-gallery preview. Warm, spreadsheet-literate, zero jargon.
- **Upload/dropzone** — drag target with type/size hints, paste-from-clipboard, multi-sheet Excel handled with a friendly **sheet/header picker**, live parse progress.
- **Workspace** — three panes: virtualized data grid (spreadsheet-familiar), describe/chat column with step timeline, diff ribbon docked above the grid; toolbar with undo/redo, download, Save as recipe, original↔result toggle.
- **Parameters panel** — a small form of labeled controls for the recipe's inferred knobs ("Minimum order amount: $100", "Group by: Region ▾"), sitting beside the workspace and on the re-run screen. Editing a value re-runs client-side instantly (no LLM); the diff + charts update live. "Make adjustable" on any step literal promotes it to a parameter.
- **Recipe library** — cards (name, source-file shape, last run, step count, mini before/after sparkline); search, folders/tags; "Run on new file" is the primary card action.
- **Recipe detail / versioning** — step list, version-history timeline with diffs + rollback, sample I/O, "used N times."
- **Re-run** — the recipe shows its **named input slots** ("Orders", "Customers"), each a labeled drop target hinting the columns it expects. Dropped files **auto-match to slots by schema** (filename similarity as tiebreaker) regardless of this month's filenames; the user can reassign, and a mismatch opens the **column-mapping helper**. Then run deterministically → same diff ribbon + charts + one-click download.
- **Sharing** — link (view / clone / collaborate) with a preview of what it does and **no data attached by default** — recipes travel, data doesn't.
- **Public template gallery** — curated, categorized recipes ("Dedupe a mailing list," "Clean a Shopify export," "QuickBooks reconciliation prep"); one-click "Use this template," then drop your file. Top-of-funnel + SEO + teaches by example.
- **Scheduling (premium)** — connect a source (Drive/email/folder), pick a cadence, auto-run on each new file to a destination; clear premium gate with value framing.
- **Settings/billing** — account, connected sources, plan + usage meter, team seats, data-retention and delete-my-data controls (trust-critical for this audience).

### 4.5 Visual design direction
Aim for the calm confidence of **Notion / Linear / Airtable** with the familiarity of Google Sheets. **Light-first with a real dark mode.** Base is a warm off-white (`#FBFBFA`) + soft neutral grays (not clinical white); one trustworthy accent — a calm indigo/blue-violet (`#5B5BD6`) for primary actions; **green for additions/success**, a **muted rose (never alarm-red)** for removals; diffs use tint fills, not saturated blocks. Typography: humanist sans (Inter) for UI, **tabular/monospace numerics** for the grid and diff counters so numbers align. Rounded corners (8–12px), soft shadows, airy padding. **Motion is meaningful and gentle** — rows fade/slide on removal, the diff counter animates counting down, applied steps settle with a soft spring; nothing bouncy. Lucide-style line icons. Trust cues everywhere ("Original file untouched" chip, lock icon on privacy statements, deterministic-replay promise). Overall feel: *a friendly, modern spreadsheet that happens to be smart — never a terminal, never a dev tool.*

### 4.6 Empty / onboarding / error states
Empty library is never a dead end (illustrated card + "Try sample data"). First-run onboarding is inline coach-marks (max two, dismissible), not a modal takeover. Generation shows a "Thinking through your steps…" shimmer with a skeleton preview (~3s, cancelable). **Failures are never raw errors:** if the AI can't map the request it responds conversationally ("Which column has the order total — `amount` or `total_paid`?" with clickable column chips); technical errors become "That one tripped me up — want to rephrase, or try one of these?" with safe suggestions. "Looks wrong" is handled by the preview stage itself (nothing was applied) + "Not quite — refine" + per-step undo + a "Compare to original" side-by-side.

### 4.7 Accessibility & responsiveness
WCAG 2.1 AA: color-independent diffs (icon + strikethrough + label, never color alone), 4.5:1 contrast, visible focus, full keyboard operation of grid and chat, ARIA-live diff announcements, `prefers-reduced-motion` respected. Desktop = three-pane workspace; tablet collapses chat to a slide-over; mobile becomes a stacked describe-first flow so a small-biz owner can clean a file from a phone.

---

## 5. Business model

**Freemium, not free-trial** — the magic must be felt before payment; a trial clock kills the "let me just try my one file" impulse.
- **Free:** unlimited *running* of saved recipes (cheap for us, builds habit), small cap on *creating* (e.g. 3–5 saved recipes, N generations/month). Generation is our cost and the value, so meter it — not runs.
- **Pro (~$19/mo individual):** unlimited recipes + generations, larger files, cloud library, version history. Priced just under $20 to sit in expensable-without-approval territory.
- **Team (~$12/user/mo):** shared library, roles, run history/audit log — where finance actually pays.
- Gate on **convenience** (cloud sync, sharing, scale, scheduling), never on privacy paranoia alone.

**Virality loops:** recipe sharing as the core loop (a shared chore is a viral invite that lands the recipient in-product with the recipe pre-loaded); a seeded template gallery for the top ~20 recurring chores (each an SEO landing page for a specific pain); bottoms-up team spread via shared libraries; a subtle "made with Data Recipes" provenance breadcrumb on outputs.

**North-star metric:** recipes saved *and re-run at least once* (proves the reuse loop, not just one-off cleaning). Supporting: time-to-first-aha, free→Pro conversion, week-4 recipe-rerun retention.

---

## 6. Risk pressure-test (my additions as PO)

1. **LLM cost & abuse on the anonymous free tier — the top financial risk.** Anonymous free generation is bot-farmable. Mitigations layered: small anon quota, invisible CAPTCHA/PoW on bursts, per-IP + per-session rate limits, model routing to Haiku for simple asks, prompt caching, hard prompt-size caps, spend anomaly alerts. Model this in a unit-economics spreadsheet before launch (cost per generation × abuse multiplier vs. conversion revenue).
2. **Silently-wrong transformations.** A non-technical user cannot audit pandas. Preview-before-apply, the plain-language diff, and deterministic replay are the guardrails — but a wrong *choice* (e.g. dedupe on the wrong key) still produces a confident, wrong result. Add lightweight sanity signals (e.g. "this removed 73% of your rows — expected?"), make the plain-language "what this will do" explicit about the assumption, and keep correction one click away. This is a trust make-or-break, especially for finance.
3. **Schema drift on re-run.** Next month's file has renamed/reordered/missing columns and the recipe breaks. The column-mapping helper (§4.4) is not optional polish — it's core to the reuse promise. Validate schema on every re-run and fail loudly with a fix path, never silently.
4. **Messy real-world Excel.** Merged cells, multi-sheet books, headers not in row 1, junk footer rows. `read_excel` on the raw file will misparse constantly. The sheet/header picker and robust ingestion are required for the ICP's actual files, not a nice-to-have.
5. **Pyodide cold start** (~10s, ~15 MB from CDN on first use). Friction at the worst moment (first run). Warm the worker on page load (already done in the MVP), show honest progress, and consider self-hosting the wheels to remove the third-party CDN dependency.
6. **Thin technical moat.** The stack is copyable in a weekend. Defensibility = accumulated recipe libraries (compounding switching cost) + template-gallery network effects + brand/trust. Fund sharing and the gallery from v1, not "later."
7. **Privacy-story integrity.** The hybrid model is a strength only if we're scrupulously honest about the client/cloud boundary. One silent server-side upload of user data torches the entire differentiator. Per-feature badges, explicit opt-in, and a plain-language data page are load-bearing.

---

## 7. Phasing

- **MVP (validate the funnel):** Next.js migration + server-side LLM proxy (kills BYO-key) + anonymous-first cloud persistence + the describe→preview→apply loop polished + sample-data path + **v2 recipe contract (multi-file inputs, multi-table output)** so the join wedge is testable from day one. Client-side execution only. Instrument the funnel.
- **v1 (make it sticky & monetizable):** accounts (magic-link + OAuth) with anonymous→auth linking, recipe library + versioning, re-run-on-new-file with schema mapping, **charts (Plotly.js render path + curated bundle)**, sharing links, Stripe + metering, template gallery seeded (including join and chart templates).
- **v2 (premium/automation):** server-side execution path, scheduling, connectors, teams + audit history, larger files.

Success gate to move MVP→v1: a meaningful share of first-run users reach the aha moment *and* a meaningful share of those save a recipe. If the reuse loop doesn't show up, revisit the wedge before building billing.
