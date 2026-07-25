// color-wheel-math.ts — pure polar math for the colour-grading wheels (#275).
// No Angular dependencies — importable by both the component and unit tests.
//
// A wheel is a unit disc inscribed in the widget's square box. The puck's
// ANGLE carries hue in degrees and its RADIUS carries saturation in
// [0, 100]. Hue 0° points right (+x) and increases counter-clockwise, so
// the wheel reads the same way as the `cos h` / `sin h` pair
// `raw_core::stages::color_grade` builds its Oklab (a, b) offset from.
//
// Positions are expressed in the same fractional box coordinates the WB
// pad uses — x right, y UP — so the template's `top` binding is
// `(1 - y) * 100`.

/** A puck position in fractional box coordinates: x right, y up, both [0, 1]. */
export interface WheelPos {
  readonly x: number;
  readonly y: number;
}

/** A wheel's two polar values. */
export interface WheelValue {
  /** Hue in degrees, `[0, 360)`. */
  readonly hue: number;
  /** Saturation in `[0, 100]` — the puck's radius as a percentage. */
  readonly saturation: number;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** Wrap an angle in degrees into `[0, 360)`. */
export function wrapHue(deg: number): number {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Puck position → `(hue, saturation)`. Positions outside the unit disc are
 * clamped to the rim, so a drag that leaves the box saturates rather than
 * jumping. Both values are rounded to whole units, matching the integer
 * precision the XMP serializers write.
 */
export function posToWheel(pos: WheelPos): WheelValue {
  const dx = clamp01(pos.x) * 2 - 1;
  const dy = clamp01(pos.y) * 2 - 1;
  const radius = Math.min(1, Math.hypot(dx, dy));
  // Exactly at the centre the angle is undefined; hold hue at 0 so a
  // saturation-0 puck has a stable, reproducible value.
  const hue = radius === 0 ? 0 : wrapHue((Math.atan2(dy, dx) * 180) / Math.PI);
  return { hue: Math.round(hue) % 360, saturation: Math.round(radius * 100) };
}

/**
 * `(hue, saturation)` → puck position. The inverse of {@link posToWheel}
 * up to the rounding both directions apply; saturation is clamped into
 * `[0, 100]` so an out-of-range model value still lands on the wheel.
 */
export function wheelToPos(value: WheelValue): WheelPos {
  const radius = Math.max(0, Math.min(100, value.saturation)) / 100;
  const rad = (wrapHue(value.hue) * Math.PI) / 180;
  return { x: (radius * Math.cos(rad) + 1) / 2, y: (radius * Math.sin(rad) + 1) / 2 };
}

/** Arrow-key step sizes — one degree of hue, one point of saturation.
 *  Module-private: `nudgeWheel` is the only consumer, and the keyboard
 *  contract it implements is pinned by `color-wheel-math.spec.ts` through
 *  `nudgeWheel` itself rather than through the step constants. */
const HUE_STEP_DEG = 1;
const SAT_STEP = 1;

/**
 * Apply an arrow-key nudge. Left/Right rotate the hue, Up/Down grow and
 * shrink the saturation. Returns `null` for any other key so the caller
 * can leave the event alone.
 */
export function nudgeWheel(value: WheelValue, key: string): WheelValue | null {
  switch (key) {
    case 'ArrowLeft':
      return { hue: wrapHue(value.hue - HUE_STEP_DEG), saturation: value.saturation };
    case 'ArrowRight':
      return { hue: wrapHue(value.hue + HUE_STEP_DEG), saturation: value.saturation };
    case 'ArrowDown':
      return { hue: value.hue, saturation: Math.max(0, value.saturation - SAT_STEP) };
    case 'ArrowUp':
      return { hue: value.hue, saturation: Math.min(100, value.saturation + SAT_STEP) };
    default:
      return null;
  }
}
