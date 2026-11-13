# Drag Bar

**Tier:** Molecules-L1

## Purpose

A tick-marked ruler for scrubbing one value. The photo stays visible because the ruler is only a
strip of ticks and a marker.

Two implementations share the look:

- **`MuiDragBar`**, the design-system molecule. Apple has `Molecules/MuiDragBar.swift`, the web
  has `lib/ui/drag-bar/`, and Windows has `MuiDragBarMath` plus the WinUI smoke surface. It's
  dependency-free, has no undo or haptics integration, and is horizontal only.
- **The Apple editor ruler**: `LivingSlider` with the `.dragBar` and `.verticalDragBar` styles
  (`src/apple/Maple/Views/LivingSlider.swift`), wrapped by `DragBar`. It edits the selected tool's
  field with the slider's transaction, fine-mode and haptics contract, so a whole drag is one
  undo step.

## Variants

- **Horizontal** (all platforms): the minimum is on the leading end and the maximum on the
  trailing end. The compact editor shows it under the photo for the selected tool.
- **Vertical** (Apple editor ruler only, `LivingSlider.Style.verticalDragBar`, #5564): the same
  ruler turned on end, with the maximum at the top. It's the right-hand column of the landscape
  vertical control bar on iPad and the open Duo (`EditorVerticalControlBar`), next to the group
  tabs and the tool buttons. Web and Windows have no landscape vertical bar, and `MuiDragBar` has
  no vertical variant.
- **Gradient track:** for tools whose values follow a colour or tone gradient (Temperature, Tint,
  Exposure…), an 8 pt capsule filled with that gradient replaces the 1 pt baseline. The vertical
  ruler runs the gradient from bottom to top.

Both orientations draw the same geometry along their own axis. There are 21 ticks, and the 11th
(index 10) is always the emphasised middle tick, whatever the range. Ordinary ticks are 6 pt long
across the axis and the middle tick is 14 pt.

## States

- **Default:** the baseline or gradient capsule, the ticks, and the value marker at the current
  value.
- **Dragging:**
  - The editor ruler moves relative to where the drag started, so touching it never makes the
    value jump.
  - Horizontal drags track left and right; vertical drags go up for more and down for less.
  - `MuiDragBar` jumps to the touch point. On the web it can also move relative to the drag
    start (`dragMode`).
- **Fine mode:** in the editor ruler and web `MuiDragBar`, a long press scales the rest of the
  drag down. The editor ruler waits 0.5 s and scales to 0.25×, starting from the value already
  shown.
- **Disabled:** input is ignored, for example while a sidecar loads.
- **Hidden (vertical bar):** tools without a single primary field (Crop, HSL, Color Grade, Tone
  Curve, Film, Geometry, Lens, Defringe, Mask, Heal) show their own panel instead of the ruler.

## Tokens used

- Editor ruler:
  - Baseline and ordinary ticks: `ProTokens.border`
  - Middle tick and the gradient capsule's outline (at 50%): `ProTokens.borderHi`
  - 2 × 22 pt value marker: `ProTokens.accent`
- Vertical bar surface: `ProTokens.bg` at `ProGlass.opacity`, 18 pt corner radius, column dividers
  in `ProTokens.border`
- `MuiDragBar` uses the generated `MuiTokens`:
  - Apple: `border` ticks, `borderHi` capsule outline
  - Web: `border` ticks, a `primary` middle tick, a `text-main` marker

## Props

- Editor ruler (`LivingSlider`):
  - `label`, used as the accessibility label
  - `value` (binding)
  - `range`
  - `defaultValue`, the reset target
  - `gradient` (optional stops)
  - `style`: `.dragBar` or `.verticalDragBar`
- `MuiDragBar`, Apple:
  - `label` (optional)
  - `value`
  - `range`
  - `step`
  - `gradientColors`
  - `disabled`
- `MuiDragBar`, web:
  - Inputs: `label`, `ariaLabel`, `min`, `max`, `step`, `disabled`, `testId`, `dragMode`
    (`absolute` | `relative`), `longPressMs` and `fineModeSensitivity`
  - Outputs: `dragStart`, `dragEnd`, `fineModeEngaged`, `crossedZero` and `reachedExtreme`

## Accessibility

- The editor ruler:
  - It's one adjustable element in either orientation, labelled with the tool name and valued with
    the formatted value.
  - Increment and decrement work as its adjustable action. It also has named actions: "Reset",
    which does the same as double-tap, and "Fine adjustment".
  - Keyboard (when focused): Left/Down decrease, Right/Up increase, and Home/End jump to the ends of
    the range. The vertical ruler keeps these keys, so Up raises the value, matching the drag
    direction.
- `MuiDragBar`:
  - On Apple, it's an adjustable element labelled "Drag bar" unless a label is given.
  - On the web, it's a `role="slider"` with arrow-key nudges.
- In the vertical bar, each group tab is a separate button labelled with the group name. The label
  is only turned on end when drawn, so VoiceOver reads it the usual way. The bar's Reset All button
  is labelled "Reset all adjustments".
