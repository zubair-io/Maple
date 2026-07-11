// wb-dng-temperature.ts — Robertson-isotherm mapping between CIE 1960 `uv`
// chromaticity and Adobe's displayed (temperature, tint) white-balance pair.
//
// Faithful TypeScript port of raw-core's `color::dng_temperature` module
// (src/raw-pipeline/raw-core/src/color/dng_temperature.rs), itself a port
// of the Adobe DNG SDK's `dng_temperature.cpp` — specifically
// `dng_temperature::Set_xy_coord` (xy → temp/tint, `xyToTempTint` below)
// and `dng_temperature::Get_xy_coord` (temp/tint → xy, `tempTintToXy`
// below). The 31-entry `TEMP_TABLE` and the perpendicular-distance-to-
// isotherm search are reproduced from the Robertson (1968)
// correlated-color-temperature method exactly as ACR ships it; the table
// values below match the DNG SDK source (and its widely-cited derivatives,
// e.g. RawTherapee's `ColorTemp` and LibRaw's `Robertson` table).
//
// Ticket #1894: this module exists to reproduce the numbers ACR *displays*
// on its white-balance temperature/tint sliders. It is deliberately
// separate from the legacy locus map in `xmp-wb-scale.ts`, which implements
// Maple's PRE-#1894 white-balance value mapping built on the
// Hernández-Andrés (1999) daylight/blackbody locus — a different curve fit,
// kept only so ≤V4-authored sidecars can be re-expressed through the
// physical chromaticity they encoded; it is not required to agree
// numerically with ACR's slider labels. Use this module to convert to/from
// the (K, tint) numbers a user reads off ACR (or the Maple UI's ACR-parity
// slider values).
//
// Pinned bit-for-bit-close (not merely "looks right") against golden
// vectors generated from the Rust reference implementation — see
// `wb-dng-temperature.spec.ts`.

/** One row of the Robertson 1968 isotherm table. */
interface TempTableEntry {
  /**
   * Reciprocal correlated color temperature, in units of
   * micro-reciprocal-degrees (i.e. `1.0e6 / temperature_kelvin`), also
   * known as "mired" — ranges 0..600 across the table, corresponding to
   * roughly ∞K down to ~1667K.
   */
  readonly r: number;
  /** The CIE 1960 `uv` chromaticity of the blackbody/daylight locus point
   * at this reciprocal temperature. */
  readonly u: number;
  readonly v: number;
  /** The slope of the isotherm line through `(u, v)`, in `dv/du`. */
  readonly t: number;
}

/**
 * The Robertson 1968 correlated-color-temperature table, as shipped in
 * Adobe DNG SDK's `dng_temperature.cpp`. 31 rows, `r` from 0 to 600 mired.
 */
const TEMP_TABLE: readonly TempTableEntry[] = [
  { r: 0.0, u: 0.18006, v: 0.26352, t: -0.24341 },
  { r: 10.0, u: 0.18066, v: 0.26589, t: -0.25479 },
  { r: 20.0, u: 0.18133, v: 0.26846, t: -0.26876 },
  { r: 30.0, u: 0.18208, v: 0.27119, t: -0.28539 },
  { r: 40.0, u: 0.18293, v: 0.27407, t: -0.3047 },
  { r: 50.0, u: 0.18388, v: 0.27709, t: -0.32675 },
  { r: 60.0, u: 0.18494, v: 0.28021, t: -0.35156 },
  { r: 70.0, u: 0.18611, v: 0.28342, t: -0.37915 },
  { r: 80.0, u: 0.1874, v: 0.28668, t: -0.40955 },
  { r: 90.0, u: 0.1888, v: 0.28997, t: -0.44278 },
  { r: 100.0, u: 0.19032, v: 0.29326, t: -0.47888 },
  { r: 125.0, u: 0.19462, v: 0.30141, t: -0.58204 },
  { r: 150.0, u: 0.19962, v: 0.30921, t: -0.70471 },
  { r: 175.0, u: 0.20525, v: 0.31647, t: -0.84901 },
  { r: 200.0, u: 0.21142, v: 0.32312, t: -1.0182 },
  { r: 225.0, u: 0.21807, v: 0.32909, t: -1.2168 },
  { r: 250.0, u: 0.22511, v: 0.33439, t: -1.4512 },
  { r: 275.0, u: 0.23247, v: 0.33904, t: -1.7298 },
  { r: 300.0, u: 0.2401, v: 0.34308, t: -2.0637 },
  { r: 325.0, u: 0.24792, v: 0.34655, t: -2.4681 },
  { r: 350.0, u: 0.25591, v: 0.34951, t: -2.9641 },
  { r: 375.0, u: 0.264, v: 0.352, t: -3.5814 },
  { r: 400.0, u: 0.27218, v: 0.35407, t: -4.3633 },
  { r: 425.0, u: 0.28039, v: 0.35577, t: -5.3762 },
  { r: 450.0, u: 0.28863, v: 0.35714, t: -6.7262 },
  { r: 475.0, u: 0.29685, v: 0.35823, t: -8.5955 },
  { r: 500.0, u: 0.30505, v: 0.35907, t: -11.324 },
  { r: 525.0, u: 0.3132, v: 0.35968, t: -15.628 },
  { r: 550.0, u: 0.32129, v: 0.36011, t: -23.325 },
  { r: 575.0, u: 0.32931, v: 0.36038, t: -40.77 },
  { r: 600.0, u: 0.33724, v: 0.36051, t: -116.45 },
];

/**
 * Adobe's tint-to-uv-offset scale factor, from `dng_temperature.cpp`.
 * Negative: a positive tint value is a *negative* multiple of the isotherm
 * unit vector's `(u, v)` displacement — see the sign-convention note on
 * `xyToTempTint`.
 */
const TINT_SCALE = -3000.0;

/** Convert CIE xy chromaticity to CIE 1960 uv chromaticity. */
function xyToUv(x: number, y: number): [number, number] {
  const denom = -x + 6.0 * y + 1.5;
  return [(2.0 * x) / denom, (3.0 * y) / denom];
}

/** Convert CIE 1960 uv chromaticity to CIE xy chromaticity. */
function uvToXy(u: number, v: number): [number, number] {
  const denom = u - 4.0 * v + 2.0;
  return [(1.5 * u) / denom, v / denom];
}

/**
 * Normalized isotherm direction vector `(du, dv)` for table row `index`,
 * i.e. the unit vector along the isotherm line whose slope is
 * `TEMP_TABLE[index].t`.
 */
function isothermUnitVector(index: number): [number, number] {
  const slope = TEMP_TABLE[index].t;
  const len = Math.sqrt(1.0 + slope * slope);
  return [1.0 / len, slope / len];
}

/** First index `i` (0..29) for which `r < TEMP_TABLE[i + 1].r`, or 29. */
function tempTintBracketIndex(r: number): number {
  for (let i = 0; i < 30; i++) {
    if (r < TEMP_TABLE[i + 1].r) return i;
  }
  return 29;
}

/**
 * Convert a CIE xy chromaticity coordinate to ACR's displayed
 * (temperature in Kelvin, tint) pair.
 *
 * Port of `dng_temperature::Set_xy_coord`. Walks the Robertson isotherm
 * table looking for the two rows whose isotherms bracket `xy`'s projection
 * onto the blackbody/daylight locus, then interpolates reciprocal
 * temperature and reads off the signed perpendicular distance along the
 * isotherm as tint.
 *
 * Sign convention (pinned on the Rust side by
 * `tint_sign_convention_pins_to_dng_sdk_math`, derived from the ported
 * math's actual output rather than assumed): at a fixed temperature,
 * increasing tint moves the recovered chromaticity toward *higher* CIE xy
 * `y` — empirically, at 5000K, `tempTintToXy(5000, +50)[1] >
 * tempTintToXy(5000, -50)[1]`. This falls out of `uu3`/`vv3 * tint /
 * TINT_SCALE` given `TINT_SCALE = -3000` and the (all-negative) isotherm
 * slopes in `TEMP_TABLE`.
 */
export function xyToTempTint(x: number, y: number): [number, number] {
  const [u, v] = xyToUv(x, y);

  let lastDt = 0.0;

  for (let index = 1; index <= 30; index++) {
    const [du, dv] = isothermUnitVector(index);

    const uu = u - TEMP_TABLE[index].u;
    const vv = v - TEMP_TABLE[index].v;

    const dt = -uu * dv + vv * du;

    if (dt <= 0.0 || index === 30) {
      const dtPos = -Math.min(dt, 0.0);

      const f = index === 1 ? 0.0 : dtPos / (lastDt + dtPos);

      const temperature = 1.0e6 / (TEMP_TABLE[index - 1].r * f + TEMP_TABLE[index].r * (1.0 - f));

      const [uu1, vv1] = isothermUnitVector(index - 1);
      const [uu2, vv2] = isothermUnitVector(index);

      const uu3Raw = uu1 * f + uu2 * (1.0 - f);
      const vv3Raw = vv1 * f + vv2 * (1.0 - f);
      const len3 = Math.sqrt(uu3Raw * uu3Raw + vv3Raw * vv3Raw);
      const uu3 = uu3Raw / len3;
      const vv3 = vv3Raw / len3;

      const tint = (uu * uu3 + vv * vv3) * TINT_SCALE;

      return [temperature, tint];
    }

    lastDt = dt;
  }

  // Unreachable: the loop always returns at index === 30 (mirrors the
  // Rust `unreachable!("loop always returns by index == 30")`).
  throw new Error('xyToTempTint: loop exited without returning (unreachable)');
}

/**
 * Convert ACR's displayed (temperature in Kelvin, tint) pair to a CIE xy
 * chromaticity coordinate.
 *
 * Port of `dng_temperature::Get_xy_coord`. Finds the bracketing table rows
 * for the reciprocal temperature, interpolates the locus `uv` point and
 * isotherm direction, offsets along the isotherm by `tint / TINT_SCALE`,
 * and converts back to xy.
 */
export function tempTintToXy(temperature: number, tint: number): [number, number] {
  const r = 1.0e6 / temperature;

  const index = tempTintBracketIndex(r);

  const f = (TEMP_TABLE[index + 1].r - r) / (TEMP_TABLE[index + 1].r - TEMP_TABLE[index].r);

  const u = TEMP_TABLE[index].u * f + TEMP_TABLE[index + 1].u * (1.0 - f);
  const v = TEMP_TABLE[index].v * f + TEMP_TABLE[index + 1].v * (1.0 - f);

  const [uu1, vv1] = isothermUnitVector(index);
  const [uu2, vv2] = isothermUnitVector(index + 1);

  const uu3Raw = uu1 * f + uu2 * (1.0 - f);
  const vv3Raw = vv1 * f + vv2 * (1.0 - f);
  const len3 = Math.sqrt(uu3Raw * uu3Raw + vv3Raw * vv3Raw);
  const uu3 = uu3Raw / len3;
  const vv3 = vv3Raw / len3;

  const uFinal = u + (uu3 * tint) / TINT_SCALE;
  const vFinal = v + (vv3 * tint) / TINT_SCALE;

  return uvToXy(uFinal, vFinal);
}
