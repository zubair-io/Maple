# Divider

## Purpose
A 1px hairline separator between content regions. The unified guide's elevation philosophy is
"hairlines do the work of shadows" — the Divider atom is the literal building block of that
principle, used far more heavily in this system than box-shadow.

## Variants
- **Horizontal** — full-width (or full-available-width) 1px line. The default and by far the most
  common orientation.
- **Vertical** — full-height 1px line, for inline toolbar/rail separators (e.g. between grouped
  buttons in a control rail).

## States
Non-interactive — a Divider has no hover/pressed/focused/disabled state.

## Tokens used
- Color: `color.border` (default); `color.border_hi` for a divider that needs to read as more
  prominent against `color.border`-toned neighboring content (e.g. separating an actively-dragged
  region) — matches `border_hi`'s existing doc comment ("one tier up from `border` to preserve
  contrast headroom").
- Spacing: none intrinsic to the atom itself — the *gap* around a divider is the surrounding
  layout's spacing token, not the divider's own.

## Props
- `orientation`: `horizontal | vertical` (default `horizontal`).
- `emphasis`: `default | high` — maps to `color.border` vs `color.border_hi`.

## Accessibility
- Purely decorative — implementations must mark it non-interactive and excluded from the
  accessibility tree (SwiftUI `.accessibilityHidden(true)`, Angular `aria-hidden="true"`, WinUI
  `AutomationProperties.AccessibilityView="Raw"`) unless it's doing double duty as a semantic list
  separator, in which case the platform's native separator role should be used instead of a bare
  visual line.
