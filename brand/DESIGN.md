# Abracadata — design language

> **"Grimoire."** Abracadata is a modern conjurer's instrument: you speak a wish
> over messy data and it hands back clean structure, *like magic*. The interface
> should feel like a cross between a **spellbook**, an **alchemist's lab
> notebook**, and a **star chart** — precise data grids inked in violet on warm
> parchment or midnight velvet, gilded with a little antique gold. Crafted, a
> touch uncanny, exact. Never a stock SaaS dashboard.

## Principles

1. **Instrument, not dashboard.** Calm, precise, considered. Favor hairlines and
   quiet surfaces over heavy drop-shadows and busy chrome. The tool recedes; the
   data and the result are the subject.
2. **Parchment & midnight.** The ground is a *material*, not a blank canvas —
   warm paper in light, deep velvet in dark, both faintly ruled like graph paper
   / a field of stars. Warmth and depth, never flat grey.
3. **Ink & gilt.** Violet is the **ink** — it carries structure and every
   interaction. Gold is **gilt** — rare and precious, reserved for the "spark":
   the logo, an eyebrow, the moment something is conjured. If gold is everywhere,
   it is nowhere.
4. **Editorial voice.** A characterful serif (Fraunces) for display gives craft
   and a hint of mischief; a clean humanist grotesque (Hanken Grotesk) runs the
   working UI. The serif is the spell; the grotesque is the lab bench.
5. **Restraint is the trick.** One flourish per view. The magic lands because
   everything around it is quiet — so spend boldness once and keep the rest calm.

## Type

- **Display — Fraunces** (self-hosted, optical serif). The hero, section and
  stage titles, big numerals. Italic for the single hero line — a flourish.
  Used at size, never for dense UI.
- **UI / body — Hanken Grotesk** (self-hosted). Everything operational: labels,
  controls, tables, chat, body copy. Warm and legible without being Inter-generic.
- **Mono — system monospace.** Recipe code only.
- Scale is deliberate; headings get tight tracking and `text-wrap: balance`,
  body copy room to breathe (~65 char measure), numeric columns `tabular-nums`.

## Color

The established Alchemical palette (tokens in `frontend/src/styles.css`), by role:

| Role | Light | Dark |
|---|---|---|
| Ink / brand accent — **violet** | `#6A2CD4` | `#A685FF` |
| Gilt / spark — **antique gold** | `#C47D10` | `#F2B53D` |
| Ground (parchment ↔ midnight) | `#FAF8F4` | `#131019` |
| Surface | `#FFFFFF` | `#1B1725` |
| Ink (text) | `#211C2B` | `#ECE8F4` |
| Success / Danger (state, *not* brand) | `#1F9E6A` / `#C93F6B` | `#4FCF94` / `#EC7BA6` |

Neutrals carry a faint violet bias so the greys read as *chosen*. Semantic
color (good/bad) is kept distinct from the two brand hues. `--on-accent` flips
to dark ink in dark mode so controls stay legible on the luminous accent.

## Surface & texture

- **The ruled ground.** A very faint dot-grid (~5% opacity) tiles the ground —
  graph paper in light, a sparse violet star-field in dark. Texture, not pattern:
  it should register only when you look for it. Surfaces sit opaque on top.
- **Panels are pages.** Hairline (1px) borders, a soft low shadow, ~12px radius —
  a printed panel, not a floating Material card. The result panel is *the stage*:
  a slightly recessed, framed surface where the conjured output appears.
- **The data-cell grid** (three cells + a spark) is the brand's core shape — it
  is the logo, and it echoes in the ruled ground and the "how it works" flow.

## Motion

Minimal and purposeful. A gentle sparkle at the moment of conjuring; hover
micro-interactions no larger than they need to be. Nothing ambient or looping.
Always honor `prefers-reduced-motion`.

## Do / Don't

- **Do** lead with the serif at display size; keep the UI in the grotesque.
- **Do** let the ground feel like a material; keep borders hairline.
- **Don't** use decorative gradients, or over-round (no `rounded-2xl` everything).
- **Don't** let gold become common, or stack stock drop-shadows on every card.
- **Don't** reach for an off-the-shelf system (Material, Bootstrap) — matching a
  generic kit is exactly the "generic SaaS" look we're leaving behind.
