# Progress

**Tier:** Atom

## Purpose

Communicates that a longer-running operation is underway — an export batch, an upload, an
indexing pass — either as a filling bar or a filling ring, with a known percentage when one's
available and an animated indeterminate treatment when it isn't.

## Variants

- **Bar** — a horizontal filling track. The default; fits inline in a list row or a toolbar.
- **Ring** — an SVG stroke-dasharray ring. Fits where a bar's aspect ratio doesn't (a compact
  status chip, a thumbnail overlay).

## States

- **Determinate** — `value` 0–100 fills the bar/ring proportionally, animating smoothly as it
  changes.
- **Indeterminate** — `value` is `null`; the bar shows a sliding stripe, the ring rotates
  continuously — both communicate "working, no known ETA" without implying a specific percentage.
- **Labeled** — either shape, plus a short text label (e.g. "60%", "Exporting 12/40").

## Tokens used

- Color: `color.surface` (track), `color.primary` (fill/ring stroke), `color.text_muted` (label).
- Radius: `radius.full` (bar track and fill — a fully round pill, matching the catalog's rounded
  progress-bar convention).

## Props

- `shape`: `bar | ring` (default `bar`).
- `size`: `sm | md` (default `md`).
- `value`: number 0–100, or `null` for indeterminate (default `null`). Out-of-range values clamp
  into 0–100 rather than overflowing the bar/ring.
- `label`: optional string.

## Accessibility

- Renders `role="progressbar"` with `aria-valuenow`/`aria-valuemin`/`aria-valuemax` set for the
  determinate state; those three attributes are omitted entirely (not zeroed) for indeterminate,
  which is the standard ARIA signal that no known percentage exists.
- `label`, when present, is rendered as visible text — not merely as an `aria-label` — so both
  sighted and assistive-tech users get the same information.
