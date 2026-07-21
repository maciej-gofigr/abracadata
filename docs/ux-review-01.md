# UX review #1 — new-user walkthrough

Reviewing the built app (post slice-2) as someone non-technical who's never seen it. States reviewed: empty landing, "Load sample," describe→generate, save/library.

## First impression (empty landing)
The page is **bare and a little confusing for a newcomer.** You get a title, a one-line tagline, a big empty dashed box, a small text link, and an empty "Recipe library" card. Nothing shows *what the app does* or *why I'd want it*. The approved prototype opened with a before/after hero and a 3-step "Drop → Describe → Reuse" — all of that is gone here.

| # | Issue | Severity |
|---|---|---|
| 1 | No "what is this / how it works" — a non-technical user lands and doesn't know what to do | High |
| 2 | The fastest path to the aha ("Load sample") is a tiny grey text link, easy to miss | High |
| 3 | An empty "Recipe library" card shows before you've done anything — clutter that presumes you know what a "recipe" is | Med |
| 4 | The dropzone is a large empty rectangle — no icon, no life; lots of dead space below | Low |

## Core flow (after Load sample / describe)
Clicking "Load sample" **dumps you into a dense wall at once**: two input tables, a describe box, a params panel, an output table, a big chart, a save bar, a "Script" link, and the library. There's no guidance on where to look or what to do next, and you didn't *do* anything to get here, so you don't learn the loop.

| # | Issue | Severity |
|---|---|---|
| 5 | **Overwhelming density** on first load — no visual hierarchy guiding the eye or a "you are here / do this next" | High |
| 6 | **The describe box (the primary action) is buried** below the input previews — it should lead | High |
| 7 | **Params mismatch (bug):** after you *describe* a new recipe, the params panel from the previous recipe (sample's "Minimum order amount" / "Group by") still shows, even though the new recipe doesn't use them — editing them does nothing useful or errors | High |
| 8 | **Three overlapping "save" concepts** — "Save to library" (green), the "Script" panel's "Save recipe" (downloads a `.py`), and the script editor — with no explanation of the difference. A non-technical user won't grok "library" vs "download `.py`" | High |
| 9 | **Code/jargon leaks through** — a prominent "Script" panel, "Save recipe" → `.py`, "recipe" everywhere. The product promise is *hide the code for non-technical people*; here it's front-and-center | Med |
| 10 | **Machine-y output names** — the AI names tables/plots like `orders_per_customer` and `top_customers_bar`, and those raw snake_case strings become the card/section headings a user reads | Med |
| 11 | **The whole value prop — "re-run on next month's file" — is invisible.** The library has an "Open" button but nothing explains that opening + dropping a new file is the monthly-reuse magic | High |
| 12 | No "what next" after a result — download? save? re-run? Unscaffolded | Med |

## Visual polish
The built app is a **plain, utilitarian dev UI** (basic cards, a single green accent) — a big step down from the approved prototype's calm, considered look (warm palette, clear hierarchy, friendly tone). This is the largest gap between the shipped app and the agreed design vision.

## Verdict
The plumbing is great; the **first-run experience is not yet "radically simple."** A newcomer would feel dropped in the deep end, and a couple of things (params mismatch, three saves, jargon) are actively confusing — not just unpolished.

## What I'm doing about it

**Implementing autonomously (clear wins, aligned with the approved PRD/prototype):**
- Fix #7 (params bug): clear/replace params when a new recipe is generated or opened, so the panel always matches the current recipe.
- Fix #10: prettify table/plot names for display (title-case, drop underscores).
- Fix #6: lead with the describe box; move input previews below it.
- Fix #2/#3: make "Try the sample" a real button, and hide the empty library card for brand-new users (show it once you have saved recipes).
- Fix #8/#9: make "Save to library" the single primary save; demote code to a quiet "Show the steps ⌄ / Download .py" (de-jargoned), matching the prototype's progressive disclosure.
- Fix #1/#11: add a short "how it works" on the empty state and a one-line reuse hint on saved recipes.

**One decision for you (below):** how far to take the *visual* overhaul now (#5 + polish) — a full prototype-fidelity restyle is a meaningful chunk of work and may be premature mid-build.
