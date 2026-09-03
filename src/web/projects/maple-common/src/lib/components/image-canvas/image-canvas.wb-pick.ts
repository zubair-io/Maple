// White-balance pick geometry (#2434) — the one piece of math that turns a
// click on the canvas into the normalised image-relative point the raw-core
// sampler takes.
//
// No Angular, no DOM: `ImageCanvasComponent` supplies the same numbers it
// hands `drawCanvas2d`, so the point is derived from the geometry that
// actually painted the pixel the user clicked.

/** The painted image's placement, exactly as `drawCanvas2d` computes it. */
export interface PickGeometry {
  /** Viewport size in CSS px. */
  wrapW: number;
  wrapH: number;
  /** Displayed image size in CSS px (`computeEffectivePx`). */
  canvasW: number;
  canvasH: number;
  /** Pan offset in CSS px. */
  pan: { x: number; y: number };
}

/** A normalised image-relative point: `(0, 0)` top-left, `(1, 1)` bottom-right. */
export interface NormalisedPoint {
  nx: number;
  ny: number;
}

/**
 * Map a click at CSS offset `(px, py)` inside the canvas wrap to a normalised
 * image point, or `null` when the click landed on the letterbox rather than
 * the image.
 *
 * The image rect is centred in the viewport and shifted by the pan — the same
 * destination rect `drawCanvas2d` draws into — so this inverts the paint
 * transform rather than re-deriving it: a click at any zoom or pan resolves to
 * the pixel under the cursor.
 */
export function normalisedImagePoint(
  px: number,
  py: number,
  geom: PickGeometry,
): NormalisedPoint | null {
  const { wrapW, wrapH, canvasW, canvasH, pan } = geom;
  if (canvasW <= 0 || canvasH <= 0) return null;
  const left = wrapW / 2 + pan.x - canvasW / 2;
  const top = wrapH / 2 + pan.y - canvasH / 2;
  const nx = (px - left) / canvasW;
  const ny = (py - top) / canvasH;
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
  return { nx, ny };
}
