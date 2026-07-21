# UX review #4 — applying & sharing recipes

Reviewing the new "apply an existing recipe" experience and sharing, driven live end-to-end
(owner authors → shares → a *fresh session* opens the link → applies on their own files → saves a copy;
and owner opens their own recipe → applies → edits).

## What's new for a user

**A dedicated apply screen** (`ApplyView`) replaces the old "open recipe → cluttered authoring
workspace." It's focused and webapp-like:
- **Named drop-slots**, one per input (e.g. *orders*, *customers*), each with an expected-columns hint
  ("expects: Order ID, Customer ID, Amount, Date…") and its own drag/drop target.
- **Settings** (the knobs) right below.
- **Auto-runs** the moment every slot is filled; output tables + charts + Download CSV appear inline.
- A clear "Drop a file into all N slots to run" hint, and a filled slot shows a green ✓ + the filename.

**Sharing is one click.** A Share icon on each library recipe → a panel with the unique link
(`/s/{token}`), **Copy**, and **Stop sharing**. The share icon turns accent-blue while shared.

**The recipient flow** (the growth loop): open the link — no account needed — land straight in the
apply screen titled with the recipe name and *"Shared recipe · your files stay in your browser."* Drop
files, get results, optionally **Save a copy to my library**. Their data never leaves their browser;
only the recipe *text* was shared.

## Verified live
- Owner shares → fresh browser context opens the link → 2 named slots + 2 knobs render → drops both
  files → recipe auto-runs (tables + chart) → "Save a copy" lands it in the recipient's library.
- Owner **Open** → apply view (mode "owner", **Edit** button) → drop files → run → **Edit** returns to
  the authoring workspace with tabs + output preserved.
- Revoke (`Stop sharing`) 404s the link. Public fetch leaks no owner/identity. Backend 22 tests.

## Bugs caught & fixed during review
- **Stale-closure state bug:** two independent slot drops used `setSlots({...slots})` with a stale
  closure, so they clobbered each other and the "all slots filled → run" check never fired. Fixed with a
  synchronous `filledRef` (and functional `setSlots`).
- **Zero-slot recipe:** a recipe with no recorded input schema rendered no drop-slots (nothing to drop
  into). Now falls back to a single `input` slot.

## Notes / smaller follow-ups (non-blocking)
- Recipients see the recipe name + description (the original prompt). Sample recipes saved without a
  prompt show no description — could fall back to a one-line "what it does" summary.
- Share links are public-by-token (unguessable, revocable). Fine for friends-and-family; a future
  option could add view-only vs. allow-copy, or link expiry.
- `window.location.origin` builds the link, so it's correct per-environment (localhost now, the real
  domain in prod).

## Verdict
Applying a recipe now feels like a purpose-built webapp, and sharing is genuinely trivial — a link that
drops anyone straight into a run screen, privacy-preserving by construction. Ready to review.
