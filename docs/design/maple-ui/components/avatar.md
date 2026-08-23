# Avatar

**Tier:** Atom

## Purpose

Represents a person — in a People page grid, a shared-with list, or a comment thread. Shows the
person's photo when one is available; otherwise falls back to their initials on a color derived
from their name, so every person still reads as visually distinct even with no photo on file.

## Variants

- **Photo** — a cropped, circular photo.
- **Initials fallback** — no photo, a load failure, or an empty `src`: renders 1–2 letters on a
  solid, name-derived background instead.
- **With presence** — either of the above, plus a small presence dot in the corner.

## States

- **Default** — as above.
- **Broken photo** — an `src` that fails to load falls back to initials exactly like having no
  `src` at all; the failure is invisible to the caller (no error event to wire up).

## Tokens used

- Color: the fallback palette is drawn entirely from existing tokens rather than inventing new
  hex values — `color.primary`, `color.primary_dim`, `color.surface_hover`, `color.warn`,
  `color.border_hi`, each paired with a legible foreground (`color.text_main` or `color.bg`).
  Presence dot: `color.success_text` (online) / `color.text_muted` (offline), bordered in
  `color.bg` so it reads as a notch cut into the avatar rather than a floating dot.
- Radius: `radius.full` — always circular, per the catalog.

## Props

- `name`: string (required) — source for both the initials and the deterministic fallback color.
- `src`: optional string.
- `size`: `xs | sm | md | lg` (default `md`).
- `presence`: `online | offline | null` (default `null`, no dot).

## Accessibility

- The fallback swatch carries `role="img"` with `aria-label` set to the full `name`, not just the
  two-letter initials — a screen reader announces "Jane Doe", not "J D".
- The presence dot carries its own `aria-label` (`"online"` / `"offline"`) since color alone isn't
  an accessible signal.
- Fallback color derivation is a pure function of `name` (no randomness, no `Date.now()`) — the
  same person gets the same color every time the app loads, and automated tests can assert on it
  without special-casing timing.
