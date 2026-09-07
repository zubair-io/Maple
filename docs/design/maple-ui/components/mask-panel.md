# Mask Panel

**Tier:** Organism

## Purpose

The panel half of local adjustments (#355 / #1541): a list of the image's mask layers with
add / remove / select, and — for the selected layer — its shape controls (feather, invert) and the
ten local develop controls a layer can carry (exposure, contrast, highlights, shadows, whites,
blacks, saturation, vibrance, temperature, tint) plus its colour-range refinement (#362). It takes
the slot the group's slider stack
normally fills while the Mask tool is armed, the same swap Film Panel, Tone Curve Panel and HSL
Panel make, because a layer stack is a list rather than a scalar the drag bar can arm. The canvas
half — handles and weight tint — is Mask Overlay.

## Variants

One layout, composed from List Row (one per layer, active = selected, trailing delete Button),
Button (add linear / add radial / reset, and the colour-range eyedropper), Living Slider (feather,
the ten controls, and the five colour-range coordinates) and Toggle (invert on radial layers,
colour range on any layer). Phone surfaces mount the same panel inside their bottom control bar.

## States

- **Empty** — the add row plus a muted hint; no list, no controls.
- **Populated, none selected** — the list only.
- **Selected** — the list with the active row highlighted, then the selected layer's controls.
- **Selected, colour range off** — the Colour range toggle alone; no eyedropper, no coordinates.
- **Selected, colour range on** — the toggle, the band centre in degrees, the eyedropper, and the
  five coordinate sliders (hue width, chroma min, L min, L max, feather).
- **Sampling** — the eyedropper is armed: the canvas shows the shared pick overlay and the next
  click seeds the band. A refused pick (neutral, black, off-image) leaves the layer alone and
  replaces nothing but the panel's message line.
- **Editing** — a slider drag writes the layer live (one undo entry per drag, closed on release);
  add / remove / invert / reset / colour-range enable / an eyedropper seed commit their own undo
  entries.

## Tokens used

- Inherits every token from its molecules: List Row's `surface_alt` active fill and `primary`
  2pt left border, Button's secondary/ghost styles, Living Slider's `border` → `primary` track,
  `text.muted` for the hint and row subtitles.
- Local temperature is a Kelvin DELTA off the frame's white point (±2000 K), not the absolute
  CCT the global slider carries.

## Props

- `session` (web `MaskSessionService`) / `state` (Apple): the editor state carrying the selected
  layer index and the live model.
- Reads: `localAdjustments`, the selected layer, its optional colour range, the native image size
  (a fresh radial mask is pre-corrected to read as a circle on screen).
- Writes: through the mask session's API only — web `addLinear` / `addRadial` / `remove` /
  `select` / `setAdjustment` / `setFeather` / `setInverted` / `resetAdjustments` /
  `setRangeEnabled` / `setRangeField` / `sampleRangeAt`; the Apple `EditorState+Masks` and
  `EditSession+MaskRange` twins of each, with the eyedropper on `MaskRangePicker`.
- The eyedropper arms the canvas pick overlay both eyedroppers share (web `CanvasPickService`,
  Apple `MaskRangePickOverlay` beside `WhiteBalancePickOverlay`); the sample itself is raw-core's
  `sample_mask_range`, read on the pixel entering the local-adjustments stage.

## Accessibility

- Add buttons: "Add linear mask" / "Add radial mask"; delete: "Delete <Layer name>"; reset:
  "Reset mask adjustments" — every control has a label and a stable `editor-mask-*` identifier.
- Layer rows are buttons labelled by layer name ("Linear 1", "Radial 2") and carry the selected
  trait when active; their subtitle reports "inverted" and the edited-control count.
- Sliders expose label + value and the platform's adjustable action; the feather slider is
  "Feather", the invert toggle "Invert", the colour-range toggle "Colour range" and its eyedropper
  "Sample a colour for the range" (`mask-range-eyedropper` / `editor-mask-range-eyedropper`).
- The band centre is text, not a control ("Hue 55°"); a refused pick is announced through the
  panel's message line (`mask-range-message` / `editor-mask-range-message`).
- The panel is a container element (`data-testid="mask-panel"` on the web,
  `editor-mask-section` on Apple).
