# Data Recipes — casual-user review

*July 2026. Findings from a hands-on session: fresh browser profile, no saved settings, driving the app the way a first-time visitor would. Tested: first load, CSV drop, prompting without an API key, loading and running a saved recipe, editing the script to force a failure, mobile width, and page reload. The AI-generation call itself was not exercised (requires spending on a real API key), so prompt→script quality is out of scope here.*

## Verdict

The core idea is genuinely good and the happy path already works: drop a CSV, get an instant preview, run a recipe, download the result. The "recipe" concept — a portable `.py` file that also runs outside the app — is the standout feature and a real differentiator over pasting data into a chatbot: deterministic, reusable, and private.

But **as a casual user I would bounce before ever seeing the magic.** The product's own system prompt says it targets "non-technical office workers," and that person hits a wall in the first thirty seconds: they need an Anthropic API key. Everything else on this list is fixable polish; this one is a positioning problem. As a *developer* tool ("BYO key, your data stays local"), it's honest and usable today. As a tool for the stated audience, the first-run funnel is broken.

## What works well

- **Fast, honest first screen.** The tagline ("Drop a spreadsheet, describe a transformation, keep the script") plus the privacy line ("your data never leaves this machine") communicate the pitch in two sentences. No signup, no cookie banners, no noise.
- **File loading is quick and robust.** The Pyodide runtime pre-warms in the background, so by the time I dropped a file the preview appeared near-instantly. Unicode content and empty cells rendered fine. Sticky table headers are a nice touch.
- **The diff summary is excellent.** `15 rows in → 4 rows out · added: TotalAmount · removed: Amount, Category, …` is exactly the right level of feedback — it answers "did it do what I meant?" at a glance. More of this energy, please.
- **The recipe round-trip works.** I dropped a hand-written recipe `.py` on top of a loaded CSV and it ran immediately and produced correct output. The saved file's embedded CLI (`python my-recipe.py input.csv -o output.csv`) is a great trust-builder — your work isn't locked in the app.
- **"Ask AI to fix it"** after a script failure is the right instinct (one click instead of copy-pasting an error).
- **Mobile width** degrades gracefully to a single column. Fine for a desktop-first tool.

## Friction points, in order of severity

### 1. The API-key wall kills the funnel for the stated audience
A non-technical user does not have an Anthropic API key and won't get one. Even for users who might:
- The Settings modal never says **where** to get a key — no link, no instructions, no pricing hint.
- There's no way to validate the key ("Test" button); the first feedback on a bad key is a failed generation later.
- The "Model" field is free-text, inviting typos with no guidance on valid values.

If the target really is office workers, this needs a proxy/managed tier eventually. Short of that, treat key setup as a first-class onboarding flow, not a settings field.

### 2. Your typed prompt is silently thrown away
Reproduced twice: type a request, press **Generate** with no key set → the Settings modal opens, and the prompt you typed is gone. Nothing explains *why* Settings opened. Same for **Ask AI to fix it**. So the actual first-run sequence is: compose a careful description → lose it → figure out the key situation → retype from memory. The draft should be preserved and auto-submitted (or at least restored) after the key is entered.

### 3. Failures show raw Python tracebacks and eat your output
Forcing a `KeyError` produced a ~25-line pandas traceback — `pandas/_libs/hashtable_class_helper.pxi` and all — with the only useful line (`KeyError: 'Ammount'`) buried at the bottom. For the target persona this reads as "the app is broken." Additionally, the previous *good* Output card disappears when a run fails, so one bad edit visibly destroys your result with no note that it happened. Show a one-line human summary ("The script references a column named 'Ammount', but the file has no such column") with the full traceback behind a disclosure, and keep the last good output visible but marked stale.

### 4. A page refresh loses everything, silently
File, script, and conversation all live in React state. Accidental refresh (or the OS reclaiming the tab) discards the script you spent ten minutes iterating on — no `beforeunload` warning, no session restore. "Save recipe" is the only escape hatch, and nothing nudges you toward it. Persisting the script + prompts to `localStorage` would be cheap insurance; a leave-warning is a one-liner.

### 5. The landing page undersells the product
First impression is a nearly empty page: a headline, one dashed box, and a lot of whitespace. A visitor who arrives skeptical ("why not just use Excel / ChatGPT?") gets no answer without committing a file:
- No **sample dataset / demo** ("Try it with example data") — the single cheapest conversion win, and it would also showcase the flow to users who don't have a CSV handy on their phone.
- No visual of the three-step loop (drop → describe → save recipe) or of *why the recipe matters* (re-run next month's file identically). The README explains this well; the app never does.
- The AI requirement is invisible until you're already invested — "Set API key" sits unexplained in the corner.

### 6. Loaded recipes are anonymous
After dropping my recipe `.py`, nothing shows what was loaded: no recipe name, no original prompts (the metadata contains both), and the chat panel still shows the generic "Describe a filter…" empty state. To learn what a recipe does you must expand the collapsed script panel and read Python — exactly what this audience can't do. Similarly, **Save recipe** gives zero confirmation; a file quietly lands in Downloads.

## Smaller polish items

- **Script editor** is a bare `textarea`: no syntax highlighting, no line wrap (long lines clip behind a horizontal scrollbar), collapsed by default behind a small `▸ Script` toggle. Fine for developers, alien to the persona — but arguably that's the right priority order for now.
- **Number formatting:** `842.50` displays as `842.5`, `450` as `450` — raw float rendering. Finance-adjacent users notice trailing-zero loss immediately.
- **Missing favicon** (the console's only 404) and the title flashes "Loading…" before the runtime title kicks in. Cheap fixes that make it look less like a prototype — which matters when you're asking people to drop company data on it.
- **Accessibility:** the dropzone is a click-handler `div` (not keyboard operable, no `role`), and DevTools flags form fields without `id`/`name`. The Cmd/Ctrl+Enter send shortcut exists but is never hinted.
- **Any non-Excel extension is parsed as CSV** (drag-and-drop bypasses the file-picker filter), so dropping a `.json` produces either a confusing one-column "success" or a parser traceback rather than "unsupported file type."
- **Cold start** depends on ~15 MB from jsDelivr; the "~10s" note only appears after you drop a file. Worth a subtle "preparing Python runtime…" indicator on page load, and note that the app is CDN-dependent despite the local-only pitch.
- Sample-row sharing defaults to **on**. It's disclosed in Settings, but a privacy-first product might invert the default or surface the choice on first generation.

## Does the UI look appealing?

It's clean, quiet, and coherent — off-white background, one green accent, generous spacing. Nothing is ugly and nothing is confusing. It also has no personality: it reads as "competent internal tool," not "product I'd recommend to a coworker." That's acceptable at this stage (the neutral look supports the trust story better than something flashy would), but the emptiness of the landing state and the missing favicon/title polish currently tip it from *minimal* to *unfinished*.

## Is it obvious how to use it and what the benefits are?

The **mechanics** are obvious: one dropzone, one text box, labeled buttons. Full credit.
The **benefits** are not: the recipe concept — the entire reason this beats a chatbot — is invisible until after your first successful generation, and even then it's a small "Save recipe" button with no explanation of what you get or why you'd want it. The user has to already understand the product to discover the product.

## Top five recommendations

1. Stop discarding the typed prompt when the API key is missing — restore it after key entry (smallest fix, biggest first-run save).
2. Humanize script errors; keep the last good output visible when a run fails.
3. Add a sample-data demo and a three-step explainer to the empty landing state.
4. Turn API-key setup into guided onboarding (where to get one, link, validation) — or rethink the BYO-key requirement for the target audience.
5. Persist session state across reloads (or at minimum warn before unload), and show the name/prompts of a loaded recipe.
