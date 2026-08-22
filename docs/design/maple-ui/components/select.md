# Select

## Purpose
A single-choice dropdown control — settings pages picking among a small fixed set of options
(e.g. a sort order, a units preference). Distinct from Command Menu (a searchable, keyboard-driven
molecule for large option sets) — Select is for short, always-visible-when-open lists.

## Variants
There is one visual variant. Selects don't currently need a "search" or "multi-select" mode in any
audited screen — add those only when a real screen needs them (YAGNI, per the design spec).

## States
- **Default** — same field chrome as Input: `color.input_bg` fill, `color.border` outline.
- **Open** — the option list renders as a popover using the same elevation rule as any floating
  panel (`shadow-lifted`-equivalent — see the Divider/Card guidance: hairline plus shadow only when
  lifted off the page).
- **Focused** — identical ring treatment to Input.
- **Disabled** — identical opacity treatment to Input/Button.

## Tokens used
- Color: `color.input_bg`, `color.border`, `color.primary` (focus ring, and the selected option's
  highlight), `color.surface_hover` (hovered, non-selected option row), `color.text_main`,
  `color.text_muted`.
- Radius: `radius.md` for the closed field; `radius.md` again for the open popover (both share the
  buttons/inputs/cards tier).
- Spacing: same `spacing.sm`/`spacing.md` padding formula as Input, for the closed field; option
  rows use `spacing.sm` vertical padding.

## Props
- `value`: the selected option's value.
- `options`: an ordered list of `{ value, label }` pairs.
- `disabled`: boolean.
- `onChange`: platform-native selection-changed callback.

## Accessibility
- Must expose the native platform select/combobox role (HTML `<select>` or ARIA `combobox` +
  `listbox` pattern on web; `Picker`/`Menu` semantics on Apple; `ComboBox` on WinUI) rather than a
  purely custom-drawn popover with no assistive-technology affordance.
- Keyboard operable end-to-end: open with Enter/Space, navigate with arrow keys, commit with
  Enter, dismiss with Escape.
