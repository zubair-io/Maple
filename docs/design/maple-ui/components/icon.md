# Icon

**Tier:** Atom

## Purpose

A single glyph rendered at a fixed size scale, `currentColor`-tinted by default. The audit found
three _different_ icon systems in use today — Apple uses SF Symbols, Web uses a hand-rolled
stroke-SVG registry (`MapleIconComponent`), Windows uses raw `FontIcon` with Segoe Fluent glyph
codes — so this atom's contract is the most consequential single alignment point in the whole set,
and also the one this plan does **not** resolve: picking a single cross-platform icon set (the
unified guide recommends converging on Material Symbols Rounded for _new_ work, while treating each
platform's current stroked/native set as a legacy exception) is implementation-plan scope, not
foundation-plan scope. This contract defines the _shape_ every platform's icon atom must have,
regardless of which glyph set backs it.

## Variants

None — Icon has no variants in the Button/Badge sense. It varies by which glyph and size are
requested, not by a stylistic branch.

## States

Icon is typically non-interactive on its own (wrapped by Button/IconButton for interactivity).
No hover/pressed/focused/disabled state belongs to the Icon atom itself — those belong to whatever
interactive atom wraps it.

## Tokens used

- Color: `currentColor` by default (inherits the surrounding text/button color) — `color.text_main`
  or `color.text_muted` at call sites that don't already establish a color context.
- Size: the unified guide's five-step scale — xs 14px, sm 16px, md 24px, lg 30px, xl 36px. **These
  are not yet tokenized** in `ui_tokens.rs` (no `ICON_SIZE_TOKENS` table exists) — a follow-up
  foundation task should add one before multiple platforms start implementing Icon in parallel, to
  avoid a fourth silently-drifting value set. Flagging this explicitly rather than having each
  atom-implementation plan invent its own five numbers independently.

## Props

- `name`: the glyph identifier — the _meaning_ of this string is platform/backing-set-specific
  until the icon-system decision above is made (an SF Symbol name, an SVG registry key, a Material
  Symbols ligature name, etc.) — the contract is stable even though the value space isn't yet.
- `size`: `xs | sm | md | lg | xl` (default `md`).
- `color`: optional override; defaults to `currentColor`.

## Accessibility

- Decorative icons (most icons paired with visible text, e.g. inside a labeled Button) must be
  hidden from assistive technology (`aria-hidden`, `.accessibilityHidden(true)`,
  `AccessibilityView="Raw"`) so they aren't announced redundantly alongside their label.
- Icon-only usages (no adjacent visible text) are not self-sufficient — the _wrapping_ component
  (IconButton, etc.) is responsible for supplying an accessible label; a bare Icon atom is never
  used standalone as an interactive, unlabeled control.
