# Slider

**Tier:** Molecules-L1

## Purpose

A labelled control for one bounded number, picked by dragging a track or by keyboard. Use it in
forms and sheets: settings, merge options, export quality. For example, the panorama merge sheet's
Boundary Warp (0–100 %). The editor's adjustments use Drag Bar and Living Slider instead, because
those are built for a full-screen ruler and live scrubbing. Use Slider when the value sits in a
form among other fields, and the form row needs a label, a readout and an optional line of help
under it.

## Variants

- **Unsigned.** The range starts at zero or above, for example 0–100 %. The readout shows the
  plain value with its unit attached: `0%`, `50%`, `100%`. The readout never shows a `+`, because
  a value that can't be negative has no sign to show.
- **Signed.** The range spans zero, for example −2 to +2 EV. The readout shows a sign on positive
  values (`+0.3 EV`) so the reader can tell at a glance which side of zero the value is on.

The variant comes from the range. There's no prop to pick it. A `%` unit attaches with no space
(`50%`). Any other unit takes a space (`+0.3 EV`).

The track has no tick marks and no end labels. The readout already shows the exact value, and on a
phone-width sheet end labels crowd the track.

## States

- **Default.** Label on the left in `color.text_muted`, readout on the right in
  `color.text_main`. The track fills in `color.primary` from the minimum to the thumb and is
  `color.border` beyond it.
- **Dragging.** Same look. The readout follows every step. `onCommit` doesn't fire until the drag
  ends.
- **Focused.** The same focus ring as every other interactive atom, drawn on the thumb.
- **Disabled.** 40–50 % opacity across the whole row (label, readout, track and helper), matching
  every other atom. The value stays visible. Use this while a long job that reads the value is
  running.
- **Helper, muted.** An optional line under the track in `color.text_muted`. It says what the
  control does.
- **Helper, warning.** The same line in `color.warn`, starting with an `info` MuiIcon. It explains
  why the value didn't take effect, or took effect only in part. For example: "Not applied: the
  frames form separate pieces."

## Tokens used

- Color: `color.text_muted` (label, muted helper), `color.text_main` (readout), `color.primary`
  (filled track, thumb tint, focus ring), `color.border` (unfilled track), `color.warn` (warning
  helper).
- Spacing: `spacing.xs` between the label row and the track, and between the track and the helper.
- Type: the `tool-label` variant for the label, `value-chip` for the readout, and `body` for the
  helper, in the muted or warning text colour.

## Props

- `label`: string. Always shown.
- `value`: number, two-way bound.
- `range`: min and max. Default 0–100.
- `step`: number. Default 1.
- `unit`: string. Default empty.
- `disabled`: boolean.
- `helper`: optional string. One sentence, ideally one line at phone width.
- `helperTone`: `muted` (default) or `warning`.
- `onCommit`: called once when a drag ends or after a keyboard step, with the final value. Use it
  to start expensive work, such as re-running a preview, instead of reacting to every step of the
  drag.

## Accessibility

- Use the platform's native slider role: an HTML `input[type=range]`, SwiftUI `Slider` or WinUI
  `Slider`. Arrow keys move one step. Page Up and Page Down move ten steps where the platform
  supports them.
- The accessible name is `label`. The accessible value is the readout spoken in words, for example
  "50 percent", never "+50".
- The helper line is linked as the slider's description (`aria-describedby` on Web, an
  accessibility hint on Apple). A warning helper sits in a polite live region, so a reason that
  appears after a preview finishes is announced once and doesn't interrupt the user.
- The tap target is at least 44 × 44 pt for the thumb, even though the visible thumb is smaller.
