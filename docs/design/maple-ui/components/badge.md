# Badge

## Purpose
A small, filled status/count indicator — unread counts, low-confidence-signal chips (e.g. person
detection), star-rating glyphs. Distinct from a Toggle/Checkbox: badges are informational, not
interactive.

## Variants
- **Count** — numeric or short-text fill, `color.primary_dim` background, `color.text_main`
  foreground. Used for unread/notification counts.
- **Signal** — `color.warn` background at reduced opacity, for low-confidence/needs-review states
  (mirrors the existing person-detection-chip usage that motivated the `warn` token, per its doc
  comment in `ui_tokens.rs`).
- **Rating** — a single glyph (star) in `color.star`; not a filled pill like the other two variants.

## States
Badges are non-interactive by default — they have no hover/pressed/focused state. If a future
screen needs a *pressable* badge (e.g. a removable filter chip), that's the **Filter Chip**
molecule, not this atom — see the taxonomy note in the design spec (atoms compose no other
component; a removable badge with a close affordance is at minimum two atoms combined).

## Tokens used
- Color: `color.primary_dim`, `color.text_main`, `color.warn`, `color.star`.
- Radius: `radius.full` (badges are always fully round or fully rounded pill shape, never square
  corners).
- Spacing: `spacing.xs` (4px internal padding — badges are small by design).

## Props
- `variant`: `count | signal | rating` (default `count`).
- `value`: string or number — the displayed content.
- `label`: optional accessible description when `value` alone isn't self-explanatory (e.g. "3
  unread" rather than just "3").

## Accessibility
- Purely visual count badges (e.g. a red dot with no number) must still expose their meaning via an
  accessible label ("unread") — never convey state by color alone.
- Rating-variant badges (stars) must expose the numeric rating value to assistive technology, not
  just the glyph count.
