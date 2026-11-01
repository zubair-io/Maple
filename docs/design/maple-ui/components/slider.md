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

- **Unsigned.** When the minimum is 0 or more, for example 0–100 % or a Sharpen of 0–150. The
  readout is the plain value: `0%`, `50%`, `40`.
- **Signed.** When the minimum is below 0, for example −2 to +2 EV. Positive values show a plus
  sign (`+0.3 EV`), negative values a minus sign (`−0.3 EV`), and zero shows no sign (`0.0 EV`).

The range picks the variant; there's no prop for it. Sliders whose neutral point isn't zero, such as
white balance in kelvin, are unsigned, and their readout is the plain value. A `%` unit attaches
with no space (`50%`). Any other unit takes a space (`0.3 EV`).

The readout always shows the slider's own value, the value the user picked. If the app applied less
than that, say so in the helper line. Slider never changes or resets its own value.

The track has no tick marks and no end labels. The readout already shows the exact value, and on a
phone-width sheet end labels crowd the track.

**Changes from what ships today.** All three platforms format Slider's readout with the shared
signed formatter, so 0–100 shows `+50 %`. Slider gets its own readout format, following the rules
above. Drag Bar and Living Slider keep the signed formatter: their editor adjustments are relative
to a neutral zero. Apple's readout moves from `body` to `value-chip`, to match Web and Windows.
Windows' label-to-track gap moves from 2 to `spacing.xs`. `helper`, `helperTone`, `onCommit` and the
spoken accessible value are new on every platform; no shipped Slider has them yet.

## States

- **Default.** Label on the left in `color.text_muted`, readout on the right in
  `color.text_main`. The track fills in `color.primary` from the minimum to the thumb and is
  `color.border` beyond it.
- **Dragging.** Same look. The readout follows every step. `onCommit` waits for the drag to end.
- **Focused.** The same focus ring as every other interactive atom, drawn on the thumb.
- **Disabled.** 40–50 % opacity on the label, readout and track, matching every other atom. The
  value stays visible. Disable the slider only while a job that can't take a new value is running,
  such as the final stitch. Don't disable it during a preview that a new value would simply
  restart. The helper line stays at full opacity and stays readable, because it may explain why
  the slider is disabled.
- **Helper, muted.** An optional line under the track in `color.text_muted`. It says what the
  control does.
- **Helper, warning.** The same line in `color.warn`, starting with a decorative `info` MuiIcon.
  It explains why the value didn't take effect, or took effect only in part. Examples: "Not
  applied: the frames form separate pieces." "Limited to 62% so the image doesn't fold."
- The helper wraps onto more lines as needed and is never cut off, because the reason is the whole
  point of the line.

## Tokens used

- Color: `color.text_muted` (label, muted helper), `color.text_main` (readout), `color.primary`
  (filled track, thumb tint, focus ring), `color.border` (unfilled track), `color.warn` (warning
  helper).
- Spacing: `spacing.xs` between the label row and the track, and between the track and the helper.
- Type: `tool-label` for the label, `value-chip` for the readout, and `body` for the helper. The
  helper is the largest text in the row because people read it as a sentence; the label and readout
  are glanced at.

## Props

- `label`: string. Always shown.
- `value`: number, two-way bound. It changes on every step.
- `range`: min and max. Default 0–100.
- `step`: number. Default 1.
- `unit`: string. Default empty.
- `disabled`: boolean.
- `helper`: optional string.
- `helperTone`: `muted` (default) or `warning`.
- `onCommit`: called once with the final value when the user finishes a change. Use it to start
  expensive work, such as re-running a preview. It doesn't fire if the final value equals the value
  when the change began.
  - Pointer or touch: fires when the drag ends. A cancelled drag, for example the pointer leaving
    the window or the OS interrupting the touch, also commits, because the value has already
    changed.
  - Keyboard: fires on key-up, so holding an arrow key commits once, not once per repeat.
  - Platform hooks:
    - Web: the range input's `change` event, plus `keyup`.
    - Apple: `Slider`'s `onEditingChanged(false)`.
    - WinUI: `PointerCaptureLost` and `KeyUp`. WinUI's `ValueChanged` fires on every step and has
      no release event of its own.

## Accessibility

- Use the platform's native slider role: an HTML `input[type=range]`, SwiftUI `Slider` or WinUI
  `Slider`.
  - Arrow keys move one step.
  - Home and End jump to the minimum and maximum.
  - Page Up and Page Down keep the platform's default jump.
- The accessible name is `label`.
- The accessible value is the readout, spoken. Set it explicitly (`aria-valuetext`,
  `accessibilityValue`, the WinUI automation value), because by default the platforms speak the
  raw number.
  - `%` is spoken as "percent".
  - A sign is spoken as "plus" or "minus".
  - Other units are spoken as written.
  - For example: "50 percent", "plus 0.3 EV".
- Muted helper:
  - Web: links to the input through `aria-describedby`.
  - Apple: becomes the accessibility hint.
  - WinUI: becomes `AutomationProperties.HelpText`.
- Warning helper. A reason is state, not a hint, so:
  - Web: the helper container is always rendered (empty when there's no helper) with
    `role="status"`. Its text changes inside it, so the change is announced once, politely.
  - Apple: the reason is appended to the accessibility value ("0 percent. Not applied: the frames
    form separate pieces.") and posted once as an accessibility announcement when it appears or
    changes.
  - WinUI: the helper `TextBlock` has `AutomationProperties.LiveSetting="Polite"`.
  - The `info` icon is hidden from assistive tech, so the reason isn't announced twice.
- The tap target is at least 44 × 44 pt for the thumb, even though the visible thumb is smaller.
  The native thumbs are smaller than that on every platform, so the control gets 44 pt of height,
  and a press anywhere in that band moves the thumb.
