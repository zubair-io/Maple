# Input

**Tier:** Atom

## Purpose

A single-line text entry field — search boxes, settings text fields, filter inputs. The audit
found Web's Settings screens overwhelmingly use raw `<input>` with locally-duplicated styling
(`btn-primary`/`btn-ghost`-adjacent ad-hoc classes) rather than any shared component; Input is
one of the two highest-frequency atoms (with Button) in that surface.

## Variants

- **Default** — single-line text.
- **Search** — same visual treatment plus a leading search icon and, when non-empty, a trailing
  clear ("×") affordance.

There is no separate "multiline" variant — a multiline text area is a distinct atom (out of scope
for this initial set; add it when a real screen needs it, per the design spec's YAGNI stance).

## States

- **Default** — `color.input_bg` fill, `color.border` outline, `color.text_muted` placeholder text.
- **Focused** — outline steps to `color.primary`, matching the Button atom's focus-ring treatment
  (1px `color.primary` border) for visual consistency between the two most common interactive
  atoms.
- **Filled** — `color.text_main` value text (vs. muted placeholder).
- **Error** — outline and helper text switch to `color.error_text`; the unified guide specifies
  error-state focus swaps _both_ the border and the ring to the error color (mirroring the default
  focus-ring construction, just recolored).
- **Disabled** — 40–50% opacity, matching Button's disabled treatment.

## Tokens used

- Color: `color.input_bg`, `color.border`, `color.primary`, `color.text_main`, `color.text_muted`,
  `color.error_text`.
- Radius: `radius.md` (8px, matching Button — inputs share the buttons-and-cards radius
  tier per the unified guide's radius table).
- Spacing: `spacing.sm` (8px vertical), `spacing.md` (16px horizontal) — identical padding formula
  to Button, for visual rhythm consistency between adjacent buttons and inputs (e.g. a search bar
  next to a button).

## Props

- `variant`: `default | search` (default `default`).
- `value`: string (two-way bound).
- `placeholder`: string.
- `disabled`: boolean.
- `error`: optional string — presence triggers the Error state and is displayed as helper text.
- `onChange` / `onCommit`: platform-native value-changed and enter/blur-commit callbacks.

## Accessibility

- `placeholder` is never the only label — every Input must have an associated accessible label
  (visible `<label>`/`Text` above/beside it, or an explicit accessible-label API call), since
  placeholder text disappears once a value is entered and screen readers may not announce it
  consistently.
- Error state must be announced to assistive technology when it appears (e.g. `aria-invalid` +
  `aria-describedby` pointing at the helper text on web; SwiftUI/WinUI equivalents), not conveyed
  by color alone.
- Minimum 44px/44pt tap target height, matching Button.
