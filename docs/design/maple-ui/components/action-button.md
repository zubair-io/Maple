# Action Button

**Tier:** Atom

## Purpose

A compact icon+label pill for toolbars — the "select this tool" affordance in a control rail
(editor tool dock, filter chip row), distinct from Button in that it always carries a glyph and is
expected to sit shoulder-to-shoulder with several siblings of identical size, not stand alone as a
single loud action.

## Variants

None in the Button/Badge sense — Action Button has one visual family. It varies by **orientation**
instead:

- **Horizontal** — icon leading, label trailing, single row. The default; used in a horizontal
  toolbar.
- **Stacked** — icon above label, centered. Used in a vertical rail or a grid of tool tiles where
  width is tighter than height.

## States

- **Default** — `color.text_muted` label/icon, transparent background.
- **Hover** — `color.surface_hover` background, label/icon step to `color.text_main`.
- **Active** — same visual as hover while the pointer is down (no separate active-only styling
  needed at this atom's scale).
- **Focused** — 2px ring at `color.primary` 20% opacity, offset 2px (matches the Button atom's
  focus treatment for visual consistency across the Actions group).
- **Disabled** — 40–50% opacity, `not-allowed` cursor, excluded from tab order.
- **Selected** — `color.primary_dim` background, `color.primary` label/icon and border. This is the
  "this tool is armed" state, distinct from hover/active — a selected Action Button can still be
  hovered, and the two states compose (selected wins visually).

## Tokens used

- Color: `color.text_muted` (default), `color.text_main` (hover), `color.surface_hover` (hover
  background), `color.primary` / `color.primary_dim` (selected).
- Radius: `radius.sm` (6px — icon-button/hover-target scale, per `RADIUS_TOKENS`).
- Spacing: `spacing.xs` (4px, icon-to-label gap and stacked-orientation padding) and `spacing.sm`
  (8px, horizontal-orientation padding).

## Props

- `icon`: the glyph identifier (see the Icon atom contract) — required, every Action Button carries
  one.
- `label`: string — the visible and accessible text.
- `size`: `sm | md` (default `md`).
- `orientation`: `horizontal | stacked` (default `horizontal`).
- `selected`: boolean.
- `disabled`: boolean.

## Accessibility

- `label` is always visible text (unlike Button, Action Button has no icon-only mode) and doubles as
  the accessible name — no separate `aria-label` is needed.
- `selected` must be exposed to assistive technology via a pressed/toggle state (`aria-pressed`),
  not conveyed by background color alone.
- Disabled Action Buttons must be excluded from the tab/focus order, not merely visually dimmed.
