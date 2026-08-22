# Checkbox

**Tier:** Atom

## Purpose

A binary or tri-state selection control for lists of independent options (as distinct from Toggle,
which is for a single immediate-effect on/off setting — see the Toggle atom contract's own Purpose
section for the exact distinction).

## Variants

- **Checkbox** — two-state (checked/unchecked).
- **Indeterminate** — a third visual state (a dash rather than a checkmark) for "some but not all"
  children selected, e.g. a parent row in a selectable tree.

## States

- **Unchecked** — `color.border` outline box, transparent fill.
- **Checked** — `color.primary` fill, `color.text_main`-on-primary checkmark glyph.
- **Indeterminate** — `color.primary` fill, dash glyph instead of checkmark.
- **Focused** — same ring treatment as Button/Input (1px `color.primary` border + 2px ring at 20%
  opacity, offset 2px).
- **Disabled** — 40–50% opacity, matching every other atom's disabled treatment.

## Tokens used

- Color: `color.border`, `color.primary`, `color.text_main`.
- Radius: `radius.xs` (4px — checkboxes are small controls, matching the guide's "chips and pills"
  radius tier rather than the buttons/inputs tier).
- Spacing: `spacing.xs` (4px, the gap between the box and its adjacent label text).

## Props

- `checked`: `true | false | 'indeterminate'`.
- `label`: string — checkboxes are almost always labeled; an unlabeled checkbox needs the same
  explicit accessible-label treatment as an icon-only Button.
- `disabled`: boolean.
- `onChange`: platform-native checked-changed callback.

## Accessibility

- Must use the platform's native checkbox role/control where one exists (HTML `<input
type="checkbox">` or ARIA `checkbox` role; SwiftUI `Toggle` with `.checkbox` style where
  available, or an explicit accessibility trait; WinUI `CheckBox`) — never a bare styled `<div>`
  with a click handler and no role.
- Indeterminate must be announced distinctly from both checked and unchecked, not merely rendered
  differently — use the platform's native indeterminate/mixed-state API, not a purely visual dash.
- Minimum 44×44pt/px tap target even though the visible box itself is smaller (radius.xs-sized) —
  same rule as Button.
