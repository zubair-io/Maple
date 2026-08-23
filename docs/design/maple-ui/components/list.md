# List

**Tier:** Atom

## Purpose

Ordered or unordered items — the plain-text list primitive underneath a bulleted description, a
numbered set of steps, or a short reference list embedded in a panel. Distinct from the List Row
molecule (`docs/design/maple-ui/components/list-row.md`): List renders bare text items with a
marker, not rows with icons/timestamps/inline actions.

## Variants

None in the Button/Badge sense — List varies by **structure**, not a stylistic branch:

- **Unordered** — bulleted (marker style below), the default.
- **Ordered** — numbered (`1.`, `2.`, …), for sequential steps.
- Items may nest: a child list renders indented inside its parent item, one level deeper per
  nesting, so "nesting indent" (the catalog's stated design requirement) is a real recursive
  structure rather than a single flat row of items.

## States

Non-interactive — List has no hover/pressed/focused/disabled state. (A List Row molecule, or a Link
atom wrapping an individual item's text, is what supplies interactivity when a list item needs to be
clickable — this atom's items are plain text.)

## Tokens used

- Color: `color.text_main` (item text), `color.text_muted` (the dash marker in the `dash` marker
  style).
- Spacing: `spacing.md` (16px, base indent) and `spacing.xs` (4px, gap between an item and a nested
  child list; also the between-item gap in `compact` density).

## Props

- `items`: an array of `{ text, children? }` nodes — required. `children` is itself an array of the
  same shape, so nesting is unbounded in principle though most call sites use one level.
- `ordered`: boolean (default `false`) — renders `<ol>` instead of `<ul>`.
- `marker`: `disc | dash | none` (default `disc`) — ignored when `ordered` is set (numbers are
  always the marker for an ordered list).
- `density`: `compact | comfortable` (default `comfortable`) — controls the vertical gap between
  items.

## Accessibility

- Renders as a native `<ul>`/`<ol>` with real `<li>` children (not `<div>`s styled to look like a
  list), so assistive technology announces the item count and list semantics for free.
- A `marker: 'none'` list (used when the visual bullet is undesired, e.g. inside a card that already
  has its own leading icon per row) still renders as a real `<ul>`/`<li>` structure — suppressing the
  marker is a visual choice made in CSS, not a structural downgrade to plain `<div>`s.
