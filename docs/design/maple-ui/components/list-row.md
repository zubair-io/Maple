# List Row

**Tier:** Atom

## Purpose

The base horizontal row primitive underlying settings rows, notebook/folder tree rows, and
filterable list items — the audit's Apple findings singled this out by name: `PhoneSettingsView`
already has a private, file-scoped `SettingsMenuRow` (icon tile + label) reused six times within
that one file, but not shared app-wide, so `AccountSettingsView`/`BackupSettingsView` each rebuild
similar layouts from scratch. List Row promotes that pattern to a real, shared atom.

## Variants

- **Default** — leading optional Icon, label text, optional trailing content (value text, Icon,
  Toggle, chevron), full-width tap target.
- **Active** — the unified guide's "active navigation row" treatment: `color.surface_alt` fill with
  a 2px `color.primary` left border — never a full `color.primary` fill for an active row.

## States

- **Default** — transparent background, `color.text_main` label.
- **Hover** — `color.surface_hover` fill, 100ms (see the Button contract's note on this duration
  not yet being tokenized).
- **Active** — see Variants above; this is a persistent state (the current selection), not a
  transient interaction state, so it composes with (doesn't replace) hover.
- **Disabled** — 40–50% opacity, matching every other atom.

## Tokens used

- Color: `color.text_main`, `color.surface_hover`, `color.surface_alt`, `color.primary` (active
  border).
- Spacing: `spacing.sm` (8px vertical padding), `spacing.md` (16px horizontal padding, matching
  Button/Input's horizontal rhythm so a row's content aligns with buttons elsewhere on the same
  screen).
- Radius: none — list rows are typically full-bleed within their container and don't carry their
  own corner radius; the _container_ (e.g. a Card wrapping a group of rows) owns radius if any.

## Props

- `icon`: optional leading Icon.
- `label`: string.
- `trailing`: optional trailing content slot (value text, Icon, Toggle, chevron — composed, not a
  fixed enum, since trailing content varies per call site).
- `active`: boolean.
- `disabled`: boolean.
- `onPress`: platform-native tap/click callback, for rows that navigate or open something.

## Accessibility

- The entire row (not just the label text) is the tap target when `onPress` is provided — minimum
  44px/44pt row height.
- `active` state must be exposed to assistive technology (`aria-current`, an equivalent
  accessibility trait/pattern), not conveyed by the left-border color alone.
- When `trailing` contains its own interactive control (e.g. an inline Toggle), that control must
  remain independently focusable/operable rather than being swallowed by the row's own tap target —
  this is the one atom in this set where two interactive elements can legitimately nest, and
  implementations must keep their hit-testing/focus order correct rather than letting the outer
  row's tap handler shadow the inner control.
