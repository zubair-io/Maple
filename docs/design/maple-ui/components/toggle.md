# Toggle

**Tier:** Atom

## Purpose

A single immediate-effect on/off switch — e.g. a settings preference that takes effect the instant
it's flipped ("enable auto-save"), as distinct from Checkbox, which is for selecting one option
among many in a list with no standalone immediate effect (e.g. picking which columns to show).
If a control's change doesn't take effect until a separate "Save"/"Apply" action, it should be a
Checkbox, not a Toggle — Toggle implies immediacy.

## Variants

One visual variant — a pill-shaped switch. No size variants are needed by any audited screen today
(YAGNI).

## States

- **Off** — `color.border`-toned track, `color.text_muted`-toned thumb, thumb positioned left.
- **On** — `color.primary` track, `color.text_main`-toned thumb, thumb positioned right. Thumb
  travel is animated (use the same un-tokenized ~200ms duration flagged in the Button contract
  until a generic interaction-motion token exists).
- **Focused** — same ring treatment as every other interactive atom.
- **Disabled** — 40–50% opacity, matching every other atom.

## Tokens used

- Color: `color.border`, `color.text_muted`, `color.primary`, `color.text_main`.
- Radius: `radius.full` (the track and thumb are both fully round, like Badge).
- Spacing: none intrinsic — track/thumb dimensions are a fixed platform-native switch size, not
  built from the spacing scale.

## Props

- `checked`: boolean.
- `label`: string — like Checkbox, almost always labeled.
- `disabled`: boolean.
- `onChange`: platform-native toggled callback.

## Accessibility

- Must use the platform's native switch role (HTML/ARIA `switch` role — not `checkbox` — since a
  toggle's semantics are "on/off state," distinct from a checkbox's "selected/unselected" semantics
  even though they look similar; SwiftUI `Toggle` with the default switch style; WinUI
  `ToggleSwitch`).
- State change must be announced immediately (native switch roles handle this automatically —
  don't build a custom-drawn toggle that bypasses it).
