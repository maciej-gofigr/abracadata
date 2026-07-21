# Agentic recipe generation — harness design

Status: **implemented** (2026-07-21). The single-shot generator was replaced by
the frontend-driven agent loop described here: `frontend/src/lib/agent.ts` (loop),
`backend/app/generate.py` (per-turn Converse tool-use oracle), and the worker tools
`preview_rows` / `column_profile` / `run_recipe_test`. Decisions taken: cell-value
access is **on by default with a disclaimer + toggle**; the agent **may ask a
clarifying question** (`ask_user`) but is prompted to prefer sensible assumptions.
Deferred: prompt caching, and a best-effort recipe on round-cap exhaustion (today it
surfaces an honest error instead).

## 1. Goal

Today generation is **one Bedrock call**: schema in → one Python block + one JSON
knob block out. The model never sees the actual data and never finds out whether
its recipe runs. We want a harness that can **inspect the data when it needs to**,
**test its own recipe**, **recover from errors automatically**, and **take several
turns** to get it right — before the user ever sees a result.

## 2. The core constraint (and the decision that follows from it)

Execution is **split-brain**:

- **Generation** is server-side (FastAPI → Bedrock Converse).
- **The data + all pandas execution** are client-side (Pyodide web worker). The
  backend never has the DataFrames, and — by deliberate security design — never
  executes user code.

So every useful tool ("show me sample rows", "run this recipe") must execute *in the
browser* and return its result to the model. The agent loop therefore has to hand
control back to the browser between tool calls.

**Decision: the agent loop lives in the frontend; the backend stays a stateless,
per-turn "advance the conversation" oracle.**

```
                 ┌─────────────────────── frontend (owns the loop) ───────────────────────┐
 user prompt ──▶ │  loop:                                                                  │
                 │    POST /generate  ── transcript ──▶  backend ──▶ Bedrock Converse       │
                 │                    ◀── assistant turn ──                                 │
                 │    turn is TOOL_CALLS?  → run each in Pyodide → append results → repeat  │
                 │    turn is FINAL?        → recipe + knobs, run it, show the user         │
                 └─────────────────────────────────────────────────────────────────────────┘
```

Each `/generate` call = exactly one Converse call and returns either **tool calls to
run** or the **final recipe**. The frontend executes tools in the Pyodide worker,
appends the results to the transcript, and calls again. This keeps the backend
stateless (no sessions, scales horizontally, reuses today's SSE plumbing) and keeps
the security boundary intact — the model's code only ever runs in the same sandboxed
worker that already runs the final recipe.

*(Alternative considered: backend owns the loop over a WebSocket and calls back into
the browser to run tools. Cleaner Bedrock-side, but adds stateful sessions + WS infra
and breaks the stateless model. Revisit only if per-turn round-trip latency hurts.)*

## 3. Tools (all executed in the Pyodide worker)

| Tool | Input | Returns | Why |
|---|---|---|---|
| `preview_rows` | `alias`, `n=5` | first N rows (actual values) + row count | See real formats: dates, `"$1,200"` strings, casing |
| `column_profile` | `alias`, `column` | categorical → unique count + top values + null count; numeric → min/max/mean/nulls | Learn exact category labels to group/filter by; spot coercion needs |
| `run_recipe` ⭐ | `script`, optional `params` | `ok`: table shapes + `head`; or `error`: the Python traceback | **Self-test.** The model runs its draft on the real data and sees success or the exact error |
| `submit_recipe` | `script`, `params[]`, `explanation` | (terminates the loop) | Structured, schema-validated finish — replaces today's brittle ```py/```json block parsing |

`run_recipe` is the centerpiece: it turns generation into a **test-driven loop**. The
model drafts → runs → reads the traceback → fixes → runs → … → submits a recipe it has
*already verified works on the user's actual data*.

Results sent back to the model are **capped** (e.g. head of ≤10 rows, values truncated)
so tool output doesn't blow up tokens.

## 4. How this satisfies the three asks (and a few more)

**1. Tool use for data context** → `preview_rows` + `column_profile`. The model pulls
more detail *only when it needs it* (schema is still provided up front for free), so
simple prompts stay one-shot and cheap.

**2. Multiple turns** → two kinds, both supported:
- *Agentic* turns within one generation (the tool loop above).
- *Conversational* turns with the user ("group by Segment instead") — the transcript
  persists across user messages, and the agent can re-inspect/re-test for the revision.

**3. Automatic feedback + retry** → three layers:
- **Tool error** (bad column name, etc.) → tool returns an error result → model retries.
- **Recipe error** → `run_recipe` returns the traceback → model fixes and re-runs. This
  is the retry engine, and it happens *before* the user sees anything.
- **Backstop**: even the final recipe is run for real by the frontend (as today); if it
  still errors, auto-append the traceback and loop once or twice more, bounded.

**Bonus wins the loop unlocks:**
- **Real-world messiness handled**: whitespace, `"$1,200"`, inconsistent categories,
  bad join keys — the model can check and coerce instead of guessing.
- **Join sanity**: `column_profile` on both files' keys catches format mismatches before
  a silent empty merge.
- **Trustworthy explanations**: "Amount was stored as text like `$1,200`, so I stripped
  the symbols before summing" — grounded in what it actually saw.
- **Structured output**: `submit_recipe` gives validated script+knobs, killing the
  regex block-parsing.

## 5. Guardrails (bounded and honest)

- **Round cap** (~6 agent turns) and **total token budget** per generation.
- **Per-tool timeout** (Pyodide run can be slow/hang); **output size caps**.
- **Best-effort fallback**: if the budget is exhausted without a verified recipe, return
  the best draft *clearly flagged* as unverified — never a dead end.
- **Cancellable**: the user can abort; the loop stops.
- Security invariant unchanged: backend executes nothing; tools run in the sandbox.

## 6. UX — make the extra turns *feel* like progress

The loop adds round-trips (each Converse call is seconds). Surface the activity live so
it reads as diligence, not lag:

> Reading a sample of `orders`… · Checking the `Region` values… · Testing the recipe… ·
> Fixing an error (KeyError: 'Region')… · Done — verified on your data.

This is arguably a feature, not a cost: the user watches it *check its work*.

## 7. Privacy — the one real tradeoff

Today we send **schema only** (columns + dtypes). `preview_rows` / `column_profile` would
send **actual cell values** to Bedrock. That's a departure from "your data never leaves
the browser" and needs a user-facing control. Options for the default:

- **(a) Schema-only, never values** — safest, weakest recipes on messy data.
- **(b) Allow value peeks, default ON**, with a visible "Let the AI look at sample values
  for better recipes" toggle. Best accuracy for the non-technical ICP; it's the user's own
  data going to the user's own Bedrock.
- **(c) Allow value peeks, default OFF** — privacy-first; power users opt in.

`run_recipe` is separate: it executes locally and only returns **shapes + a tiny head**,
so it leaks far less than free-form value sampling — could be allowed even in schema-only
mode.

## 8. Cost / latency levers

- **Prompt caching** of the stable prefix (system prompt + dataset context) across turns —
  Bedrock supports cache points; big win since we re-send the transcript each round.
- **Batched tool calls**: Converse can return several tool_use blocks at once (profile 3
  columns in one turn) — fewer round-trips.
- Simple prompts still resolve in **one** turn (model submits immediately, no tools).

## 9. Implementation surface (high level)

- **Worker** (`pyodideWorker.ts`): add `preview_rows`, `column_profile`, and a compact
  mode for the existing `run_script` (shapes + head, no 50-row preview).
- **`pyodide.ts`**: RPC methods for the new capabilities.
- **`agent.ts`** (new, frontend): the loop controller — transcript state, tool dispatch,
  round/budget caps, activity callbacks, abort.
- **`api.ts`**: `/generate` becomes "advance one turn" (streams text, ends in `tool_calls`
  or `final`).
- **`generate.py`** (backend): add `toolConfig` (tool specs) to Converse; translate the
  transcript ↔ Converse messages; return the assistant turn; cache points. Still stateless.
- **`App.tsx`**: drive the loop, render live activity, keep the conversational history.

## 10. Suggested phasing

- **Phase 1 — self-testing loop (biggest bang):** `run_recipe` + `submit_recipe` + the
  frontend loop + retry-on-error. No value-sampling yet, so **no privacy change**. This
  alone makes recipes reliably *work*.
- **Phase 2 — data inspection:** `preview_rows` + `column_profile` behind the privacy
  toggle. Handles messy/ambiguous real data.
- **Phase 3 — economy & polish:** prompt caching, batched calls, richer activity UI,
  optional clarifying-question path when a prompt is genuinely ambiguous.

## 11. Decisions I need from you

1. **Privacy default (§7):** schema-only, value-peeks-default-on, or value-peeks-default-off?
2. **Latency (§5/§6):** OK to trade a few extra seconds per generation for a *verified*
   recipe, with live activity shown? (Round cap ~6 reasonable?)
3. **Scope:** start with **Phase 1** (self-testing loop, no privacy change) and iterate,
   or design the whole thing before building?
4. **Clarifying questions:** should the agent ever pause to *ask the user* when truly
   ambiguous, or always make its best assumption and let them revise? (I lean: best
   assumption — keep it frictionless.)
