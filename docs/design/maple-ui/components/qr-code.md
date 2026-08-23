# QR Code

**Tier:** Atom

## Purpose

Renders a text payload (a pairing URL, a share link) as a scannable QR code — used by device
pairing / handoff flows where a phone camera needs to read a code off the screen.

## Variants

There is one visual style; `size` is the only axis of variation (no color/inverted variant — see
States below for why).

## States

- **Rendered** — the payload encoded and drawn to a `<canvas>`.
- **Error** — the payload can't be encoded (e.g. exceeds the QR format's capacity for the chosen
  error-correction level); shows a short inline error message instead of a broken/empty canvas.

## Tokens used

- None of the app's color tokens apply to the code itself. A QR code's modules are rendered
  black-on-white regardless of the app's dark theme — this is a functional requirement, not a
  design choice: a camera scanner needs maximum, unambiguous contrast, and a themed
  dark/light-inverted rendering would be actively worse for scan reliability. The error message
  uses `color.error_text`.
- Radius: `radius.sm` on the canvas's own corners (cosmetic only — doesn't affect the encoded
  modules).

## Props

- `value`: string (required) — the payload to encode.
- `size`: `sm | md | lg` (96px / 128px / 192px).
- `ariaLabel`: optional string override; defaults to `"QR code for {value}"`.

## Accessibility

- The canvas carries `role="img"` and an `aria-label` describing what it encodes — a screen reader
  user can't scan a QR code, so the accessible name should let them know what the equivalent
  content/link is (or that they should ask a sighted user to scan it).
- Quiet zone: a 4-module margin ships around the code by default, matching the QR spec's own
  minimum recommendation — a scanner's edge-detection needs that clear border to lock onto the
  code reliably.
