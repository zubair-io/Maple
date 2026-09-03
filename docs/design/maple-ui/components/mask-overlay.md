# Mask Overlay

**Tier:** Organism

## Purpose

The on-canvas half of local adjustments (#355 / #1541): draws the SELECTED mask layer's drag
handles over the live image canvas and a translucent red visualisation of the layer's per-pixel
weight `w ∈ [0, 1]`, in the same normalized coordinate space the render pipeline evaluates the mask
in. It is the masking sibling of Crop Overlay — one overlay per platform, dispatching on the mask's
shape for its handle set, mirroring how `mask::evaluate` is one function with a match rather than
two functions.

The weight tint is a direct read of the pipeline's own evaluator (raw-core's
`stages/local_adjustments/mask.rs`, ported per platform), never a second definition of the mask: a
tint that disagrees with the render is a bug in the port, and it is unit-tested against the
evaluator's analytic points.

## Variants

- **Linear** — a pin at each end of the gradient (`w = 0` and `w = 1`), a dashed axis between
  them, and a midpoint body handle that translates the whole gradient.
- **Radial** — a center pin (translate), a pin on the ellipse along each local axis (resize `rx` /
  `ry`), a dashed outline, and an accent-coloured rotation pin beyond the x-axis pin.

Only the selected layer renders; unselected layers show nothing (their list rows are the way in).

## States

- **Idle** — handles at rest over the tinted weight.
- **Dragging** — a handle follows the pointer; the canvas re-renders live behind it. One undo entry
  per drag, opened on the first movement.
- **No selection** — the overlay mounts empty (nothing drawn); the panel's list is the affordance.
- **Cropped image** — handles and tint are placed through the crop's affine map, so a mask on a
  cropped or straightened image is drawn where the render actually applies it.

## Tokens used

- Color: `color.primary` (rotation pin, tint hue — Apple `ProTokens.accent`), white at 0.9 for the
  axis/outline strokes and the pins, black at 0.5 for pin borders.
- Tint peak opacity 0.55 at `w = 1`, linear in `w`.
- Grab radius 14pt, matching Crop Overlay.

## Props

- `session` (web `MaskSessionService`) / `state` (Apple): the editor state carrying the selected
  layer index and the live model.
- Reads: the selected `LocalAdjustment`, the displayed image size (crop applied), the applied
  `Crop` (for the affine map), the native image size.
- Writes: the selected layer's `mask` through the editor state's mask gesture
  (`beginGesture` / `setShape` / `endGesture` on the web; `beginMaskGesture` /
  `setSelectedMaskShape` / `endMaskGesture` on Apple).

## Accessibility

- The overlay is one container element labelled "Mask overlay" whose value describes the selected
  layer ("Linear gradient mask", "Radial mask", "Inverted radial mask", or "No mask selected").
- Every handle is its own accessibility element labelled "Mask handle: <name>" (gradient start /
  gradient end / gradient / center / horizontal radius / vertical radius / rotation) with a stable
  identifier (`data-testid="mask-handle-<handle>"` on the web, `editor-mask-handle-<handle>` on
  Apple).
- The weight tint and the shape strokes are decorative and hidden from assistive technology.
- Fit-zoom-only: arming the tool snaps the canvas to fit so every handle is reachable without
  panning; the edge margin keeps a frame-edge handle's full grab radius inside the gesture region.
