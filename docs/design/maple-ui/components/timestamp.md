# Timestamp

**Tier:** Atom

## Purpose

A formatted date/time — "2m ago" under a photo, "Aug 22, 2026" in a metadata grid, an edit-session
label. Centralizes relative-time math and locale-aware absolute formatting so every call site
doesn't reimplement its own "how old is this" arithmetic.

## Variants

None in the Button/Badge sense — Timestamp varies by **format**, not by a stylistic branch:

- **Relative** — degrades through a fixed ladder as the delta grows: "just now" (under a minute) →
  "Nm ago" (minutes, under an hour) → "Nh ago" (hours, under a day) → "Nd ago" (days, up to a
  six-day ceiling) → an absolute short date beyond that. The ceiling exists so a two-year-old photo
  never renders as "731d ago" — past a week, an actual date reads faster than a huge relative count.
- **Short** — locale-formatted month/day/year, no time (e.g. "Aug 22, 2026").
- **Long** — full month name, day, year, and clock time (e.g. "August 22, 2026, 3:45 PM").
- **Time-only** — just the clock time (e.g. "3:45 PM").

## States

Non-interactive — Timestamp has no hover/pressed/focused/disabled state. It does carry a **tooltip**
in every format: the full absolute date+time rides along as the native `title` attribute, so
hovering a "2m ago" reveals the exact instant regardless of which format is displayed.

## Tokens used

- Color: `color.text_muted` (the default — Timestamp is metadata, not primary content).

No radius/spacing tokens apply — Timestamp renders as inline text with no container.

## Props

- `value`: `Date | number | string` — the point in time to render. Required. Accepts a `Date`
  object, a millisecond epoch, or an ISO-formatted string so callers don't have to normalize before
  passing it in.
- `format`: `relative | short | long | time-only` (default `relative`).
- `now`: `Date | number` — the reference "current time" for relative formatting. Defaults to the
  real clock; exists so tests (and any caller that already has a frozen "now") get deterministic
  output instead of racing `Date.now()`.

## Accessibility

- Renders as a native `<time>` element with a machine-readable `datetime` attribute (the ISO
  instant), so assistive technology and browser tooling can parse the value even when the visible
  text is a relative string like "2m ago".
- The `title` attribute carrying the full absolute date+time is a sighted-hover affordance only —
  it is not a substitute for exposing the same information to assistive technology, which already
  gets it via `datetime`.
