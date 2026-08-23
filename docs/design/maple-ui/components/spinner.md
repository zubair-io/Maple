# Spinner

**Tier:** Atom

## Purpose

The smallest possible "something is happening" indicator — a single rotating ring, used inline
next to a label or centered in an otherwise-empty box, for operations too short-lived or too small
in footprint to warrant a full Progress bar/ring.

## Variants

There is one visual style (a rotating ring); `size` and `placement` are its only axes.

## States

- **Delayed (not yet visible)** — before `delayMs` elapses, the spinner exists in the DOM but is
  fully transparent — a fast operation that finishes inside the delay window never flashes a
  spinner at all, which would otherwise read as more distracting flicker than useful feedback.
- **Visible** — after the delay, the ring fades in and spins continuously until removed.

## Tokens used

- Color: `color.border` (ring track), `color.primary` (ring's rotating arc).

## Props

- `size`: `sm | md` (default `md`).
- `placement`: `inline | centered` (default `inline`) — `centered` stretches to fill its
  container and centers the ring within it; `inline` sits at its natural size in the surrounding
  flow.
- `delayMs`: number (default `0`) — implemented as a CSS `animation-delay`, so the threshold holds
  even if the JS thread is briefly busy.
- `label`: string (default `"Loading"`) — the accessible name; not rendered as visible text.

## Accessibility

- Renders `role="status"` with `aria-label` set to `label`, so assistive tech announces that
  something is loading without needing visible text alongside the ring (the same pattern a
  bare loading spinner uses everywhere else in the app).
- The rotating ring glyph itself is `aria-hidden`; the accessible name comes from the `role="status"`
  container, not the animation.
