# UX review #2 — after the UI rebuild

Reviewing the rebuilt app (prototype-fidelity restyle + reuse loop) as a non-technical
first-time user, then as a returning user coming back "next month." States driven in a real
browser: empty landing (light + dark), sample load, describe → live generation, save, Start
over, reopen from library, drop differently-named files.

## What the rebuild fixed (from review #1)

Every High/Med issue from review #1 is resolved:

- **Visual polish** — the app now matches the approved prototype: warm ground, indigo accent,
  real hierarchy, cards, calm tone. Light *and* dark themes. (was the biggest gap)
- **#6 describe-first / #5 density** — the workspace leads with "Your files" then the describe
  card; the primary action is no longer buried.
- **#7 params bug** — params clear on generate/open, so the panel always matches the current
  recipe. Verified: after a describe-generate the stale sample knobs disappear.
- **#8/#9 three saves + jargon** — one primary "Save to library"; the code is demoted to a quiet
  "Show the steps (Python)" disclosure + "Download recipe (.py)". No more prominent "Script" panel.
- **#10 machine-y names** — table/plot headings are prettified (`orders_per_customer` → "Orders per
  customer").
- **#1/#11 onboarding + reuse** — empty state has a 3-step "Drop → Describe → Reuse"; the library
  is hidden until you have saved recipes; saved recipes carry a reuse hint.
- **#2/#3** — the sample is a real button; empty library no longer clutters a new user's landing.

## New-user flow (verified)

Land → "Sample: orders + customers" → files + describe + params + output + chart render → type a
request → **live Bedrock** generates a working recipe, streams a plain-English explanation, runs,
and shows prettified outputs → "Save to library." Clean, legible, no dead ends. No console errors.

## Returning-user / reuse flow (the headline promise — now verified)

Come back, land, see "Your recipes," click **Open** → a "Ready to re-run" banner names the recipe
and the slots it expects, the dropzone re-labels to "Drop this month's files for …", the page
scrolls up to it → drop `orders_august.csv` / `customers_august.csv` → the files **auto-snap to the
`orders` / `customers` slots by column match** and the recipe re-runs, unchanged. This is the whole
value proposition working end to end. (Previously, opening a recipe with no files loaded gave no
visible feedback — that dead end is gone.)

## Fixed opportunistically this pass

- Reopen banner + dropzone re-labeling + scroll-to-top (closed the reuse dead end).
- **Schema-based slot matching** on re-run (PRD "match by name + schema"), so next month's filename
  doesn't matter. Filename fallback also strips full month names now.
- `multiple` on the file picker (couldn't pick two files at once before).
- **Friendlier run errors** — a plain-English lead line (KeyError / missing-table / etc.) with the
  raw Python traceback tucked behind a "Technical details" toggle, instead of a bare traceback.

## Remaining, lower priority (not blocking; no decision needed)

| # | Observation | Severity | Note |
|---|---|---|---|
| A | ~~AI-generated recipes expose **no adjustable knobs**.~~ **Resolved** — `/generate` now returns an inferred knob spec; the workspace renders them as typed controls. Verified live (a "revenue by region + min amount + top-N" request produced a `$` amount, a top-N number, and a Region/Segment dropdown, all re-running on change). | ~~Med~~ done | — |
| B | Input preview tables can be tall (two side-by-side push the describe card down on first load). | Low | Could cap input previews to ~8 rows. |
| C | No "modified since last save" affordance; every save makes a new version even if nothing changed. | Low | Cheap to add a dirty check. |
| D | Iterating in the describe box appends to a growing conversation with no "start fresh." | Low | |

## Verdict

The rebuilt app delivers on "radically simple." A newcomer is oriented immediately, the core loop
is legible, and — critically — the monthly-reuse promise now actually works in the browser. The
remaining items are enhancements, not confusion. Nothing here needs a product decision from you;
recommend picking up **(A) knob inference for generated recipes** as the next feature.
