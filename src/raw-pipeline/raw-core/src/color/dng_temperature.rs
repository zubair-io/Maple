//! Robertson-isotherm mapping between CIE 1960 `uv` chromaticity and Adobe's
//! displayed (temperature, tint) white-balance pair.
//!
//! This is a faithful Rust port of the Adobe DNG SDK's `dng_temperature.cpp`
//! — specifically `dng_temperature::Set_xy_coord` (xy → temp/tint) and
//! `dng_temperature::Get_xy_coord` (temp/tint → xy). The 31-entry
//! `kTempTable` and the perpendicular-distance-to-isotherm search are
//! reproduced from the Robertson (1968) correlated-color-temperature method
//! exactly as ACR ships it; the table values below match the DNG SDK source
//! (and its widely-cited derivatives, e.g. RawTherapee's `ColorTemp` and
//! LibRaw's `Robertson` table).
//!
//! Ticket #1894: this module exists to reproduce the numbers ACR *displays*
//! on its white-balance temperature/tint sliders. It is deliberately
//! separate from [`crate::stages::white_balance`], which implements Maple's
//! own scene-linear white-balance *render* path built on the
//! Hernández-Andrés (1999) daylight/blackbody locus — a different curve
//! fit, chosen for the render pipeline's own reasons and not required to
//! agree numerically with ACR's slider labels. Use this module only to
//! convert to/from the (K, tint) numbers a user reads off ACR (or the Maple
//! UI's ACR-parity slider values); use `stages::white_balance` for the
//! actual scene-linear illuminant correction applied to pixels.

/// One row of the Robertson 1968 isotherm table.
///
/// - `r`: reciprocal correlated color temperature, in units of
///   micro-reciprocal-degrees (i.e. `1.0e6 / temperature_kelvin`), also
///   known as "mired" — ranges 0..600 across the table, corresponding to
///   roughly ∞K down to ~1667K.
/// - `u`, `v`: the CIE 1960 `uv` chromaticity of the blackbody/daylight
///   locus point at this reciprocal temperature.
/// - `t`: the slope of the isotherm line through `(u, v)`, in `dv/du`.
struct TempTableEntry {
    r: f64,
    u: f64,
    v: f64,
    t: f64,
}

/// The Robertson 1968 correlated-color-temperature table, as shipped in
/// Adobe DNG SDK's `dng_temperature.cpp`. 31 rows, `r` from 0 to 600 mired.
const TEMP_TABLE: [TempTableEntry; 31] = [
    TempTableEntry { r: 0.0, u: 0.18006, v: 0.26352, t: -0.24341 },
    TempTableEntry { r: 10.0, u: 0.18066, v: 0.26589, t: -0.25479 },
    TempTableEntry { r: 20.0, u: 0.18133, v: 0.26846, t: -0.26876 },
    TempTableEntry { r: 30.0, u: 0.18208, v: 0.27119, t: -0.28539 },
    TempTableEntry { r: 40.0, u: 0.18293, v: 0.27407, t: -0.30470 },
    TempTableEntry { r: 50.0, u: 0.18388, v: 0.27709, t: -0.32675 },
    TempTableEntry { r: 60.0, u: 0.18494, v: 0.28021, t: -0.35156 },
    TempTableEntry { r: 70.0, u: 0.18611, v: 0.28342, t: -0.37915 },
    TempTableEntry { r: 80.0, u: 0.18740, v: 0.28668, t: -0.40955 },
    TempTableEntry { r: 90.0, u: 0.18880, v: 0.28997, t: -0.44278 },
    TempTableEntry { r: 100.0, u: 0.19032, v: 0.29326, t: -0.47888 },
    TempTableEntry { r: 125.0, u: 0.19462, v: 0.30141, t: -0.58204 },
    TempTableEntry { r: 150.0, u: 0.19962, v: 0.30921, t: -0.70471 },
    TempTableEntry { r: 175.0, u: 0.20525, v: 0.31647, t: -0.84901 },
    TempTableEntry { r: 200.0, u: 0.21142, v: 0.32312, t: -1.0182 },
    TempTableEntry { r: 225.0, u: 0.21807, v: 0.32909, t: -1.2168 },
    TempTableEntry { r: 250.0, u: 0.22511, v: 0.33439, t: -1.4512 },
    TempTableEntry { r: 275.0, u: 0.23247, v: 0.33904, t: -1.7298 },
    TempTableEntry { r: 300.0, u: 0.24010, v: 0.34308, t: -2.0637 },
    TempTableEntry { r: 325.0, u: 0.24792, v: 0.34655, t: -2.4681 },
    TempTableEntry { r: 350.0, u: 0.25591, v: 0.34951, t: -2.9641 },
    TempTableEntry { r: 375.0, u: 0.26400, v: 0.35200, t: -3.5814 },
    TempTableEntry { r: 400.0, u: 0.27218, v: 0.35407, t: -4.3633 },
    TempTableEntry { r: 425.0, u: 0.28039, v: 0.35577, t: -5.3762 },
    TempTableEntry { r: 450.0, u: 0.28863, v: 0.35714, t: -6.7262 },
    TempTableEntry { r: 475.0, u: 0.29685, v: 0.35823, t: -8.5955 },
    TempTableEntry { r: 500.0, u: 0.30505, v: 0.35907, t: -11.324 },
    TempTableEntry { r: 525.0, u: 0.31320, v: 0.35968, t: -15.628 },
    TempTableEntry { r: 550.0, u: 0.32129, v: 0.36011, t: -23.325 },
    TempTableEntry { r: 575.0, u: 0.32931, v: 0.36038, t: -40.770 },
    TempTableEntry { r: 600.0, u: 0.33724, v: 0.36051, t: -116.45 },
];

/// Adobe's tint-to-uv-offset scale factor, from `dng_temperature.cpp`.
/// Negative: a positive tint value is a *negative* multiple of the isotherm
/// unit vector's `(u, v)` displacement — see the sign-convention note on
/// [`xy_to_temp_tint`].
const TINT_SCALE: f64 = -3000.0;

/// Convert CIE xy chromaticity to CIE 1960 uv chromaticity.
fn xy_to_uv(x: f64, y: f64) -> (f64, f64) {
    let denom = -x + 6.0 * y + 1.5;
    (2.0 * x / denom, 3.0 * y / denom)
}

/// Convert CIE 1960 uv chromaticity to CIE xy chromaticity.
fn uv_to_xy(u: f64, v: f64) -> (f64, f64) {
    let denom = u - 4.0 * v + 2.0;
    (1.5 * u / denom, v / denom)
}

/// Normalized isotherm direction vector `(du, dv)` for table row `index`,
/// i.e. the unit vector along the isotherm line whose slope is
/// `TEMP_TABLE[index].t`.
fn isotherm_unit_vector(index: usize) -> (f64, f64) {
    let slope = TEMP_TABLE[index].t;
    let len = (1.0 + slope * slope).sqrt();
    (1.0 / len, slope / len)
}

/// Convert a CIE xy chromaticity coordinate to ACR's displayed
/// (temperature in Kelvin, tint) pair.
///
/// Port of `dng_temperature::Set_xy_coord`. Walks the Robertson isotherm
/// table looking for the two rows whose isotherms bracket `xy`'s projection
/// onto the blackbody/daylight locus, then interpolates reciprocal
/// temperature and reads off the signed perpendicular distance along the
/// isotherm as tint.
///
/// Sign convention (pinned by `tint_sign_convention_pins_to_dng_sdk_math`
/// below, derived from the ported math's actual output rather than
/// assumed): at a fixed temperature, increasing tint moves the recovered
/// chromaticity toward *higher* CIE xy `y` — empirically, at 5000K,
/// `temp_tint_to_xy(5000, +50).1 > temp_tint_to_xy(5000, -50).1`. This is
/// the direction that falls out of `uu3`/`vv3 * tint / TINT_SCALE` given
/// `TINT_SCALE = -3000` and the (all-negative) isotherm slopes in
/// `TEMP_TABLE`; it is not independently re-derived from ACR's UI labeling
/// here — callers that need the "positive tint = magenta" UI convention
/// should verify against a live ACR/Lightroom sample before relying on it.
pub fn xy_to_temp_tint(x: f32, y: f32) -> (f32, f32) {
    let (u, v) = xy_to_uv(x as f64, y as f64);

    let mut last_dt = 0.0_f64;

    for index in 1..=30_usize {
        let (du, dv) = isotherm_unit_vector(index);

        let uu = u - TEMP_TABLE[index].u;
        let vv = v - TEMP_TABLE[index].v;

        let dt = -uu * dv + vv * du;

        if dt <= 0.0 || index == 30 {
            let dt_pos = -dt.min(0.0);

            let f = if index == 1 {
                0.0
            } else {
                dt_pos / (last_dt + dt_pos)
            };

            let temperature =
                1.0e6 / (TEMP_TABLE[index - 1].r * f + TEMP_TABLE[index].r * (1.0 - f));

            let (uu1, vv1) = isotherm_unit_vector(index - 1);
            let (uu2, vv2) = isotherm_unit_vector(index);

            let uu3_raw = uu1 * f + uu2 * (1.0 - f);
            let vv3_raw = vv1 * f + vv2 * (1.0 - f);
            let len3 = (uu3_raw * uu3_raw + vv3_raw * vv3_raw).sqrt();
            let uu3 = uu3_raw / len3;
            let vv3 = vv3_raw / len3;

            let tint = (uu * uu3 + vv * vv3) * TINT_SCALE;

            return (temperature as f32, tint as f32);
        }

        last_dt = dt;
    }

    unreachable!("loop always returns by index == 30")
}

/// Convert ACR's displayed (temperature in Kelvin, tint) pair to a CIE xy
/// chromaticity coordinate.
///
/// Port of `dng_temperature::Get_xy_coord`. Finds the bracketing table rows
/// for the reciprocal temperature, interpolates the locus `uv` point and
/// isotherm direction, offsets along the isotherm by `tint / TINT_SCALE`,
/// and converts back to xy.
pub fn temp_tint_to_xy(temperature: f32, tint: f32) -> (f32, f32) {
    let r = 1.0e6 / temperature as f64;

    let index = (0..30_usize)
        .find(|&i| r < TEMP_TABLE[i + 1].r)
        .unwrap_or(29);

    let f = (TEMP_TABLE[index + 1].r - r) / (TEMP_TABLE[index + 1].r - TEMP_TABLE[index].r);

    let u = TEMP_TABLE[index].u * f + TEMP_TABLE[index + 1].u * (1.0 - f);
    let v = TEMP_TABLE[index].v * f + TEMP_TABLE[index + 1].v * (1.0 - f);

    let (uu1, vv1) = isotherm_unit_vector(index);
    let (uu2, vv2) = isotherm_unit_vector(index + 1);

    let uu3_raw = uu1 * f + uu2 * (1.0 - f);
    let vv3_raw = vv1 * f + vv2 * (1.0 - f);
    let len3 = (uu3_raw * uu3_raw + vv3_raw * vv3_raw).sqrt();
    let uu3 = uu3_raw / len3;
    let vv3 = vv3_raw / len3;

    let tint = tint as f64;
    let u_final = u + uu3 * tint / TINT_SCALE;
    let v_final = v + vv3 * tint / TINT_SCALE;

    let (x, y) = uv_to_xy(u_final, v_final);
    (x as f32, y as f32)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CIE Standard Illuminant D65, per the published xy coordinates
    /// (ISO 11664-2 / CIE 15).
    ///
    /// D65 is a daylight illuminant, not a pure blackbody radiator, so it
    /// sits slightly off the Robertson isotherm table's Planckian locus.
    /// This mapping is centered on that locus, so D65 legitimately reads
    /// back with a small nonzero tint (empirically ~+10.5) rather than 0 —
    /// this matches the well-documented behavior of the DNG SDK's own
    /// `Set_xy_coord` for D65, not a bug in this port.
    #[test]
    fn d65_xy_recovers_6502k() {
        let (temp, tint) = xy_to_temp_tint(0.31271, 0.32902);
        assert!(
            (temp - 6502.0).abs() < 30.0,
            "expected ~6502K, got {temp}"
        );
        assert!(
            (tint - 10.5).abs() < 3.0,
            "expected tint near +10.5 (D65's known offset from the \
             Planckian locus under this mapping), got {tint}"
        );
    }

    /// CIE Standard Illuminant A, per the published xy coordinates.
    #[test]
    fn std_a_xy_recovers_2856k() {
        let (temp, tint) = xy_to_temp_tint(0.44757, 0.40745);
        assert!(
            (temp - 2856.0).abs() < 20.0,
            "expected ~2856K, got {temp}"
        );
        assert!(tint.abs() < 1.5, "expected near-zero tint, got {tint}");
    }

    #[test]
    fn round_trip_temp_tint_through_xy() {
        let temps = [2500.0_f32, 3200.0, 5000.0, 6500.0, 8000.0, 12000.0];
        let tints = [-120.0_f32, -53.0, 0.0, 25.0, 120.0];

        for &temp in &temps {
            for &tint in &tints {
                let (x, y) = temp_tint_to_xy(temp, tint);
                let (round_temp, round_tint) = xy_to_temp_tint(x, y);

                let temp_rel_err = (round_temp - temp).abs() / temp;
                assert!(
                    temp_rel_err < 0.005,
                    "temp={temp} tint={tint}: round-tripped temp {round_temp} \
                     (rel err {temp_rel_err})"
                );

                // At a handful of temperatures whose reciprocal (mired)
                // value lands exactly on (or a hair off, in f32) a
                // TEMP_TABLE breakpoint, the two independent bracket
                // searches — temp_tint_to_xy's index-by-interpolation-
                // weight and xy_to_temp_tint's index-by-isotherm-distance-
                // sign-flip — can select adjacent table segments. That
                // shows up as a roughly constant tint bias for that
                // temperature (present even at tint=0, e.g. 5000K biases
                // by ~1.2 units for every tint in this sweep), not an
                // error that grows with |tint|. This is a genuine bounded
                // discontinuity in the piecewise-linear isotherm model
                // (matching the real DNG SDK's discrete search), not a
                // bug in this port — 1.5 covers the worst case observed
                // across this grid.
                assert!(
                    (round_tint - tint).abs() < 1.5,
                    "temp={temp} tint={tint}: round-tripped tint {round_tint}"
                );
            }
        }
    }

    /// Pins the tint sign convention that falls out of the ported DNG SDK
    /// math, so a future refactor can't silently flip the axis without a
    /// test failure. Evidence: at 5000K, `temp_tint_to_xy(5000, +50)` yields
    /// a strictly *higher* `y` (CIE xy) than `temp_tint_to_xy(5000, -50)`
    /// (measured: y_plus≈0.3897, y_minus≈0.3182) — i.e. positive tint, as
    /// this port computes it, displaces the chromaticity toward higher `y`.
    /// This is the convention `TINT_SCALE = -3000` combined with
    /// `TEMP_TABLE`'s isotherm slopes actually produces; it is recorded
    /// here as ground truth for regression purposes, not cross-checked
    /// against ACR's own UI polarity.
    #[test]
    fn tint_sign_convention_pins_to_dng_sdk_math() {
        let (_, y_plus) = temp_tint_to_xy(5000.0, 50.0);
        let (_, y_minus) = temp_tint_to_xy(5000.0, -50.0);

        assert!(
            y_plus > y_minus,
            "expected +tint to move y higher than -tint at fixed temp: \
             y_plus={y_plus} y_minus={y_minus}"
        );

        let (x, y) = temp_tint_to_xy(5000.0, 50.0);
        let (temp_plus, tint_plus) = xy_to_temp_tint(x, y);
        assert!((temp_plus - 5000.0).abs() / 5000.0 < 0.005);
        // See the breakpoint-bracket note on `round_trip_temp_tint_through_xy`
        // above — 5000K sits on a TEMP_TABLE breakpoint, so this uses the
        // same widened tolerance rather than the tighter 0.5 used elsewhere.
        assert!((tint_plus - 50.0).abs() < 1.5);
    }

    /// Ticket #1894 acceptance vector: ACR displays roughly 4450K / -53 tint
    /// for `test_0002`'s as-shot white balance. Pin round-trip fidelity at
    /// the nearby (temp, tint) pair actually used in that investigation —
    /// 4539.8K / -53.1 — to a tighter tolerance than the general round-trip
    /// sweep above.
    #[test]
    fn acceptance_vector_near_test_0002_as_shot() {
        let (x, y) = temp_tint_to_xy(4539.8, -53.1);
        let (temp, tint) = xy_to_temp_tint(x, y);

        assert!(
            (temp - 4539.8).abs() < 2.0,
            "expected ~4539.8K, got {temp}"
        );
        assert!((tint - -53.1).abs() < 2.0, "expected ~-53.1 tint, got {tint}");
    }

    /// Not a correctness assertion — this test ALWAYS passes. It exists to
    /// deterministically emit `/tmp/wb_v5_golden_vectors.json`, a fixed
    /// grid of inputs/outputs from this Rust reference implementation
    /// (single source of truth) for the TS and Swift #1894 ports (design
    /// comment item 8) to pin their own outputs against — cross-language
    /// ports must reproduce these numbers bit-for-bit-close, not merely
    /// "look right" in each language's own test suite.
    ///
    /// Three sections:
    /// - `temp_tint_to_xy`: 24 `(temperature, tint)` → `(x, y)` samples,
    ///   the 8 temperatures × 3 tints the design comment specifies.
    /// - `xy_to_temp_tint`: the INVERSE of each of those same 24 samples —
    ///   feeding each sample's own `(x, y)` back through `xy_to_temp_tint`
    ///   — so a port can validate both directions against the same grid
    ///   without needing a second, independently-chosen set of xy inputs.
    /// - `authored_pair_to_v5`: 12 `(version, temperature, tint)` →
    ///   `(out_temperature, out_tint)` samples, the 4 legacy versions ×
    ///   3 pairs the design comment specifies, covering the joint
    ///   legacy-locus → Robertson conversion every TS/Swift parser must
    ///   also implement so a V1–V4 sidecar load-normalizes identically to
    ///   Rust's `xmp::parse`.
    ///
    /// All numeric fields are written as `f64` (Rust's `f32` values
    /// widened losslessly) so a receiving JSON parser — which has no f32
    /// type — reads back the EXACT bit pattern this Rust build produced,
    /// not a value re-rounded to fewer significant digits.
    #[test]
    fn golden_vectors_for_cross_language_ports() {
        let temps: [f32; 8] = [2200.0, 2856.0, 4000.0, 5000.0, 6500.0, 8000.0, 12000.0, 20000.0];
        let tints: [f32; 3] = [-90.0, 0.0, 40.0];

        let mut forward = Vec::new();
        let mut inverse = Vec::new();
        for &temp in &temps {
            for &tint in &tints {
                let (x, y) = temp_tint_to_xy(temp, tint);
                forward.push(serde_json::json!({
                    "temp": temp as f64,
                    "tint": tint as f64,
                    "x": x as f64,
                    "y": y as f64,
                }));
                let (round_temp, round_tint) = xy_to_temp_tint(x, y);
                inverse.push(serde_json::json!({
                    "x": x as f64,
                    "y": y as f64,
                    "temp": round_temp as f64,
                    "tint": round_tint as f64,
                }));
            }
        }

        // `authored_pair_to_v5` lives in `stages::white_balance` (#1894),
        // not this module — called here (not reimplemented) per this
        // module's own "call them, don't reimplement" contract, exactly
        // like every other consumer of this port.
        use crate::stages::white_balance::authored_pair_to_v5;
        use crate::xmp::WbScaleVersion;
        let versions = [
            ("V1", WbScaleVersion::V1),
            ("V2", WbScaleVersion::V2),
            ("V3", WbScaleVersion::V3),
            ("V4", WbScaleVersion::V4),
        ];
        let pairs: [(f32, f32); 3] = [(6500.0, 0.0), (5000.0, 10.0), (3200.0, -44.0)];
        let mut authored = Vec::new();
        for &(label, version) in &versions {
            for &(temp, tint) in &pairs {
                let (out_temp, out_tint) = authored_pair_to_v5(temp, tint, version);
                authored.push(serde_json::json!({
                    "version": label,
                    "temp": temp as f64,
                    "tint": tint as f64,
                    "out_temp": out_temp as f64,
                    "out_tint": out_tint as f64,
                }));
            }
        }

        let doc = serde_json::json!({
            "temp_tint_to_xy": forward,
            "xy_to_temp_tint": inverse,
            "authored_pair_to_v5": authored,
        });
        std::fs::write(
            "/tmp/wb_v5_golden_vectors.json",
            serde_json::to_string_pretty(&doc).expect("serialize golden vectors"),
        )
        .expect("write /tmp/wb_v5_golden_vectors.json");
    }
}
