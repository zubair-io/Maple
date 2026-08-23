# Text

**Tier:** Atom

## Purpose

A styled text block — the single atom every label, caption, title, and body copy in the system
routes through, so type scale and color roles stay centralized instead of each call site picking its
own `font-size`/`color` by hand.

## Variants

The full type scale, one variant per named scale step (`docs/design/responsive-program/s0-primitives.md`
§3.4, already tokenized in `tokens.scss`'s Tailwind `@theme` block):

- **source-title** — Merriweather, 28px/700, tight tracking. Top-level source/library titles.
- **sheet-title** — Merriweather, 17px/700. Sheet/dialog headers.
- **row-label** — Lato, 14px/400. Primary row text in lists.
- **body** — Lato, 13px/400. Default running copy.
- **tool-label** — Lato, 10px/400. Editor tool-dock labels.
- **chip-label** — Lato, 11px/700. Filter chip / pill text.
- **eyebrow** — Lato, 10px/700, uppercase, wide tracking. Section-header kicker text.
- **value-chip** — JetBrains Mono, 11px/400. Slider value readouts.
- **filename** — JetBrains Mono, 12px/400. File/asset names.

## States

Text is non-interactive — it has no hover/pressed/focused/disabled state of its own. (A Link atom
wraps Text-shaped content when a piece of text needs to be clickable.)

## Tokens used

- Typography: `--text-source-title`, `--text-sheet-title`, `--text-row-label`, `--text-body`,
  `--text-tool-label`, `--text-chip-label`, `--text-eyebrow`, `--text-value-chip`, `--text-filename`
  (each paired with its `--line-height`/`--font-weight`/`--letter-spacing` modifiers) plus
  `--font-sans` / `--font-serif` / `--font-mono`.
- Color: `color.text_main` (main), `color.text_muted` (muted), `color.text_main` again for
  on-accent (no dedicated "on accent" token exists yet — `text_main` already reads correctly over
  the primary/error accent fills used elsewhere, per button.md's primary-fill label color), plus the
  semantic trio `color.success_text` / `color.warn` / `color.error_text`.

## Props

- `variant`: one of the nine type-scale steps listed above (default `body`).
- `color`: `main | muted | on-accent | success | warning | error` (default `main`).
- `truncate`: boolean — single-line ellipsis truncation.
- `lineClamp`: number or `null` — multi-line clamp before an ellipsis; ignored when `truncate` is
  also set.
- `block`: boolean — renders as a block element instead of the default inline span, for a piece of
  text used as its own row rather than embedded in a sentence.

## Accessibility

- Text carries no semantic heading level of its own — a screen using `source-title` for an `<h1>`
  and `sheet-title` for an `<h2>` must still apply the correct heading role/level at the call site;
  this atom controls appearance, not document structure.
- Truncated/clamped text must not be the only way a value is available — the untruncated string
  should remain reachable (e.g. via a `title` attribute or an adjacent detail view) so assistive
  technology and sighted users alike aren't silently missing the tail of a long name.
- Semantic colors (`success`/`warning`/`error`) must never be the sole signal of meaning — pair with
  an icon or text content that states the condition in words.
