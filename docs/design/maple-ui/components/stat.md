# Stat

**Tier:** Atom

## Purpose

A labeled numeric value — "128 Photos", "42 Selected", a storage-usage figure. The compact
number-plus-caption pairing used in summary rows and dashboard-style panels, with an optional delta
indicator when the number is being compared against a prior period.

## Variants

None in the Button/Badge sense — Stat varies by **size**, not by a stylistic branch:

- **sm** — compact, for inline use inside a denser row or a card that shows several stats side by
  side.
- **lg** — the default, prominent single-figure display (e.g. a source's photo count in its header).

## States

Non-interactive — Stat has no hover/pressed/focused/disabled state.

## Tokens used

- Color: `color.text_main` (the value), `color.text_muted` (the label), `color.success_text` (trend
  up), `color.error_text` (trend down), `color.text_muted` again (trend flat — no separate "neutral"
  token exists, and muted already reads as "no strong signal").
- Spacing: `spacing.xs` (4px, gap between the delta's trend glyph and its figure).

No dedicated trend-arrow glyphs exist in the Icon atom's registry (only `chevron-right/left/down`,
no directional up/down pair) — the delta's trend marker is a plain typographic glyph (▲ / ▼ / –), not
a Icon-atom instance, to avoid inventing new icon artwork out of this atom's scope.

## Props

- `value`: string or number — the headline figure. Required.
- `label`: string — the caption beneath it. Required.
- `size`: `sm | lg` (default `lg`).
- `delta`: string or number, or `null` — an optional comparison figure (e.g. `"+12"`). When omitted,
  no delta row renders at all.
- `trend`: `up | down | flat`, or `null` — pairs with `delta` to color it and add a directional
  glyph; when `null`, the delta still renders but without a trend glyph or trend coloring.

## Accessibility

- `label` must always be present as visible text adjacent to `value` — a bare number with no caption
  is not self-explanatory to a screen-reader user landing on it out of context.
- Trend direction must not be conveyed by color alone — the directional glyph (▲/▼) is decorative
  (`aria-hidden`), but the delta's own text (e.g. "+12") must independently state the direction
  (a leading sign) so the meaning survives without color or the glyph.
