// Shape primitives shared by the chrome registry (`maple-icon-registry.ts`)
// and the editor tool glyphs (`tool-glyph-shapes.ts`). Both files feed the
// same renderer (`maple-icon.component.html`), so the primitive vocabulary
// lives here rather than in either table — that keeps the two tables free of
// a circular import.

export interface ShapeBase {
  filled?: boolean;
  opacity?: number;
  /** Skip stroke-linecap/linejoin="round" so the shape renders with the
   * SVG defaults (butt cap, miter join). Used by the grid icons whose
   * 90° corners must stay sharp; rounded joins would visibly bevel the
   * 3×3 / 4.5×4.5 cells. */
  sharp?: boolean;
  /** Override the SVG fill-rule. `evenodd` lets a single filled <path>
   * combine an outer shape with inner cut-outs (e.g. `clear-circle-fill`'s
   * filled disc with an X-shaped hole that knocks out the disc fill, so
   * the X reads against the page background rather than being painted in
   * `currentColor` over a same-colored disc). Only meaningful when
   * `filled: true`. */
  fillRule?: 'evenodd' | 'nonzero';
  /** Per-shape stroke width, overriding the component's `strokeWidth` input.
   * The editor tool glyphs are drawn to a fixed 1.6 line weight (#640) so a
   * caller that renders them at a non-default size still gets the artwork's
   * intended optical weight. */
  strokeWidth?: number;
}

export type IconShape =
  | (ShapeBase & { kind: 'path'; d: string })
  | (ShapeBase & {
      kind: 'rect';
      x: number;
      y: number;
      width: number;
      height: number;
      rx?: number;
    })
  | (ShapeBase & { kind: 'circle'; cx: number; cy: number; r: number });

export const rect = (
  x: number,
  y: number,
  width: number,
  height: number,
  rx?: number,
): IconShape => ({
  kind: 'rect',
  x,
  y,
  width,
  height,
  ...(rx !== undefined ? { rx } : {}),
});

export const sharpRect = (x: number, y: number, width: number, height: number): IconShape => ({
  kind: 'rect',
  x,
  y,
  width,
  height,
  sharp: true,
});

export const path = (d: string): IconShape => ({ kind: 'path', d });

export const circle = (cx: number, cy: number, r: number): IconShape => ({
  kind: 'circle',
  cx,
  cy,
  r,
});
