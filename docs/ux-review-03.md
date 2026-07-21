# UX review #3 — the agentic recipe generator

Reviewing the new agent harness (tool use + multi-turn + self-test/retry + clarifying
questions) as a first-time user, driven live against the running app. All four
capabilities were exercised end-to-end with real Bedrock + Pyodide.

## What a new user now experiences

Describe a request → the app **shows its work** as it goes: "Read a sample of orders",
"Read a sample of customers", "Checked the *Status* values", "Testing the recipe on your
data…", each with a check as it completes → then the verified result. The agent inspects
the data when it helps, **tests its own recipe and fixes errors before you see anything**,
and only asks a question when genuinely stuck.

Verified live:
- **Tool use** — "exclude refunded orders" → the agent profiled the `Status` column to
  learn the exact "refunded" label before writing the filter.
- **Multi-turn + revision** — region → "group by segment instead" → "only paid orders",
  three turns, no errors, each result correct.
- **Self-test / retry** — every generation ends with a green "Recipe ran successfully";
  `run_recipe` surfaces tracebacks to the model to fix before submitting.
- **Clarifying question** — "flag the suspicious orders" → the agent asked what
  "suspicious" means; answering resumed the loop to a finished recipe.
- **Privacy** — a clear toggle + disclaimer; with data access OFF, generation still
  works from schema alone (no value peeks; `run_recipe` returns only shapes).
- **Cancel** — a Stop button; cancelling safely resets the chat context (recipe/output
  stay).

## Bug caught during review (fixed)

Converse requires **alternating roles and paired tool_use/tool_result**. The first
implementation recorded a completed recipe as the `submit_recipe` tool call (plus a
synthetic result), which left the transcript ending on a user-role message — so the
**first conversational revision would have errored**. Fixed by recording a *final* as a
plain assistant turn (`agent.ts`); multi-revision flows now verified clean.

## Verdict

The generator is meaningfully more capable and more trustworthy: recipes are tested
before they're shown, messy real-world data is handled by inspection rather than
guessing, and the live activity makes the extra turns read as diligence. Intuitive for a
new user — nothing here needs a product decision.

## Deferred (not blocking)

- **Prompt caching** of the stable transcript prefix (cost/latency) — batched tool calls
  already happen (the model previews multiple files in one turn).
- **Best-effort recipe** if the round cap (~6) is hit — today it surfaces an honest
  "took too many steps" error rather than an unverified recipe.
