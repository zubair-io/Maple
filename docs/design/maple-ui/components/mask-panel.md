# Mask Panel

**Tier:** Organism

## Purpose

The panel half of local adjustments (#355 / #1541): a list of the image's mask layers with
add / remove / select, and — for the selected layer — its shape controls (feather, invert) and the
ten local develop controls a layer can carry (exposure, contrast, highlights, shadows, whites,
blacks, saturation, vibrance, temperature, tint). It takes the slot the group's slider stack
normally fills while the Mask tool is armed, the same swap Film Panel, Tone Curve Panel and HSL
Panel make, because a layer stack is a list rather than a scalar the drag bar can arm. The canvas
half — handles and weight tint — is Mask Overlay.

## Variants

One layout, composed from List Row (one per layer, active = selected, trailing delete Button),
Button (add linear / add radial / reset), Living Slider (feather + the ten controls) and Toggle
(invert, radial layers only). Phone surfaces mount the same panel inside their bottom control bar.

## States

- **Empty** — the add row plus a muted hint; no list, no controls.
- **Populated, none selected** — the list only.
- **Selected** — the list with the active row highlighted, then the selected layer's controls.
- **Editing** — a slider drag writes the layer live (one undo entry per drag, closed on release);
  add / remove / invert / reset commit their own undo entries.

## Tokens used

- Inherits every token from its molecules: List Row's `surface_alt` active fill and `primary`
  2pt left border, Button's secondary/ghost styles, Living Slider's `border` → `primary` track,
  `text.muted` for the hint and row subtitles.
- Local temperature is a Kelvin DELTA off the frame's white point (±2000 K), not the absolute
  CCT the global slider carries.

## Props

- `session` (web `MaskSessionService`) / `state` (Apple): the editor state carrying the selected
  layer index and the live model.
- Reads: `localAdjustments`, the selected layer, the native image size (a fresh radial mask is
  pre-corrected to read as a circle on screen).
- Writes: through the mask session's API only — web `addLinear` / `addRadial` / `remove` /
  `select` / `setAdjustment` / `setFeather` / `setInverted` / `resetAdjustments`; the Apple
  `EditorState+Masks` twins of each.

## Accessibility

- Add buttons: "Add linear mask" / "Add radial mask"; delete: "Delete <Layer name>"; reset:
  "Reset mask adjustments" — every control has a label and a stable `editor-mask-*` identifier.
- Layer rows are buttons labelled by layer name ("Linear 1", "Radial 2") and carry the selected
  trait when active; their subtitle reports "inverted" and the edited-control count.
- Sliders expose label + value and the platform's adjustable action; the feather slider is
  "Feather", the invert toggle "Invert".
- The panel is a container element (`data-testid="mask-panel"` on the web,
  `editor-mask-section` on Apple).
