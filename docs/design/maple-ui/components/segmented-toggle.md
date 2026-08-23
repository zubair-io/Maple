# Segmented Toggle

**Tier:** Atom

## Purpose

A compact, exclusive picker for 2–3 closely related view modes (Grid/List, before/after) — the
sliding-indicator alternative to a row of separate toggle buttons, used where only one option can
ever be active and switching between them is frequent (e.g. the Browse grid/list switch).

## Variants

- **2-segment** — a simple binary switch (e.g. Grid / List).
- **3-segment** — the same control with a third option (e.g. Grid / List / Map). More than three
  segments is out of scope — at that point the picker belongs to a different atom (a Select or a
  tab strip), per the catalog's own 2–3 range.

## States

- **Default** — unselected segments render in `color.text_muted` on a `color.surface` track.
- **Selected** — the sliding indicator (`color.surface_hover`, matching the codebase's existing
  hover-surface tone) sits under the active segment; its label switches to `color.text_main`.
- **Focus** — focus-visible ring on the focused segment, matching Button/Input/Checkbox's shared
  ring treatment.
- **Disabled** — 40–50% opacity, matching every other atom's disabled treatment; selection is
  frozen (clicks are ignored).

## Tokens used

- Color: `color.surface`, `color.surface_hover`, `color.text_main`, `color.text_muted`,
  `color.primary` (focus ring).
- Radius: `radius.sm` (track), `radius.xs` (segment/indicator) — the "chips and pills" tier, one
  step down from Button/Input's `radius.md`.
- Motion: the `group-swap` motion pair (120ms `ease-in-out`) drives the indicator's slide — the
  same duration the editor already uses for its own group/tool tab swap, since a segmented toggle
  is functionally the same "swap which of N things is active" motion.

## Props

- `options`: an ordered list of `{ value, label }` pairs (2–3 entries).
- `value`: the selected option's `value` (two-way bound).
- `disabled`: boolean.

## Accessibility

- Exposed as a single `radiogroup` containing `radio` segments (not a row of independent buttons)
  so assistive tech announces "2 of 3, Grid" rather than three unrelated buttons — matches how a
  native segmented control reads on every platform.
- Each segment carries `aria-checked` reflecting whether it's the active value.
- Minimum 44×44 tap target per segment, matching every other interactive atom's rule, even though
  the visible segment can be narrower.
