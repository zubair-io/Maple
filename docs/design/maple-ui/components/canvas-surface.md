# Canvas Surface

**Tier:** Atom

## Purpose

The reusable chrome around any GPU- or 2D-rendered layer — sizes and letterboxes a `<canvas>`
against the image-canvas backdrop, and hands the caller the raw canvas element once it exists in
the DOM. Canvas Surface owns none of the actual drawing; it's the box the real render pipeline
(the Metal/WebGL2/2D image canvas) paints into, factored out so every host of a live canvas gets
the same sizing/backdrop/loading behavior for free instead of reimplementing it per screen.

## Variants

There is one visual treatment; what varies is the `contentAspect` the caller supplies (or omits,
for edge-to-edge fill).

## States

- **Loading (before first frame)** — a spinner overlay sits over the empty canvas until the caller
  flips `loading` to `false` once it has painted something.
- **Ready** — overlay removed; the canvas shows whatever the caller has drawn into it.

## Tokens used

- Color: `color.image_canvas` (backdrop, both behind the canvas and behind the loading overlay),
  `color.border` / `color.primary` (spinner ring).

## Props

- `contentAspect`: optional `width / height` number. Drives the letterbox: the canvas is capped to
  the host box on both axes at that ratio, so it shrinks on whichever axis is tighter. `null`
  (default) fills the host box edge-to-edge with no aspect constraint.
- `loading`: boolean (default `false`).
- `canvasReady`: output — emits the real `HTMLCanvasElement` once it exists in the DOM
  (`ngAfterViewInit`), so the caller can hand it to its own render pipeline.

## Accessibility

- The loading overlay's spinner is `aria-hidden` — a screen reader has no useful account of a
  loading image canvas beyond whatever surrounding caption/label the calling screen already
  provides.
- Canvas Surface itself renders no accessible name; the caller is responsible for labeling what
  the canvas depicts (e.g. "Photo preview") at the call site, the same way it would for a plain
  `<canvas>` used directly.
