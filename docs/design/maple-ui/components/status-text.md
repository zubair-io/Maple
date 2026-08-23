# Status Text

**Tier:** Atom

## Purpose

A one-line persistence/sync status — "Saving…", "Saved", "Offline", "Error" — paired with an icon,
shown near wherever an edit or a sync operation just happened (e.g. next to a sidecar autosave, a
settings form, a sync indicator) so the user has continuous, low-key confirmation of what state
their data is in.

## Variants

There is one visual treatment; `state` selects which of the five default icon+text pairings shows.
`text` can override the default label per instance (e.g. `"Saved 2m ago"`) while keeping the
state's icon and color.

## States

- **Idle** — a neutral dot, `color.text_muted`. Nothing to report.
- **Saving** — an in-progress glyph, `color.text_muted`. An operation is in flight.
- **Saved** — a checkmark, `color.success_text`. The operation completed.
- **Offline** — a quiet dismiss glyph, `color.text_muted` (deliberately not the same visual weight
  as Error — being offline isn't a failure, just a known, recoverable condition).
- **Error** — a filled alert glyph, `color.error_text`. Something needs the user's attention.

## Tokens used

- Color: `color.text_muted` (idle/saving/offline), `color.success_text` (saved),
  `color.error_text` (error).
- Icon set: constrained to the existing glyph registry — no wifi/cloud/spinner-dedicated icon
  exists yet, so Saving reuses the `history` glyph (reads as "in progress") and Offline/Error are
  distinguished by weight (`x` vs. the filled `clear-circle-fill`) rather than a dedicated
  connectivity icon. Flagged here as a gap for a follow-up icon-registry addition, not silently
  worked around.

## Props

- `state`: `idle | saving | saved | offline | error` (required).
- `text`: optional string override of the state's default label.

## Accessibility

- Renders `role="status"` so a state change (e.g. saving → saved) is announced to assistive tech
  without the user needing to have focus on the element.
- The icon is always paired with visible text — state is never conveyed by color or glyph alone.
