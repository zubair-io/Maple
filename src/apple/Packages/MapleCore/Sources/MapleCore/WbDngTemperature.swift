// WbDngTemperature.swift — Robertson-isotherm mapping between CIE 1960 `uv`
// chromaticity and Adobe's displayed (temperature, tint) white-balance pair
// (#1894).
//
// Faithful Swift port of `raw-core/src/color/dng_temperature.rs`, itself a
// faithful port of the Adobe DNG SDK's `dng_temperature.cpp`
// (`Set_xy_coord` / `Get_xy_coord`). The 31-entry `kTempTable` and the
// perpendicular-distance-to-isotherm search are reproduced exactly — see
// the Rust file's header for the full derivation and sign-convention
// notes. Math is Double throughout (mirroring Rust's internal `f64`
// working precision even though the public Rust API is `f32` in/out).
//
// Also carries the legacy Hernández-Andrés daylight-locus map (mirroring
// `raw-core/src/stages/white_balance.rs`'s `cct_to_xy` /
// `apply_tint_perpendicular` / `tint_perpendicular_axis` / `locus_tangent_uv`)
// and `authoredPairToV5`, the joint legacy-locus → Robertson conversion
// (mirroring `raw-core/src/stages/white_balance_v5.rs`'s
// `authored_pair_to_v5`) that every V1–V4 sidecar must load-normalize
// through so a Maple-authored slider value stamps into the correct domain.
//
// Cross-language ports (this file, the TypeScript port, the Rust
// reference) are pinned bit-for-bit-close against golden vectors generated
// from the Rust implementation — see `WbDngTemperatureTests.swift`.

import Foundation

public enum WbDngTemperature {

    // MARK: - Robertson 1968 isotherm table

    private struct TempTableEntry {
        let r: Double
        let u: Double
        let v: Double
        let t: Double
    }

    /// The Robertson 1968 correlated-color-temperature table, as shipped in
    /// Adobe DNG SDK's `dng_temperature.cpp`. 31 rows, `r` (reciprocal
    /// megakelvin / mired) from 0 to 600.
    private static let tempTable: [TempTableEntry] = [
        TempTableEntry(r: 0.0, u: 0.18006, v: 0.26352, t: -0.24341),
        TempTableEntry(r: 10.0, u: 0.18066, v: 0.26589, t: -0.25479),
        TempTableEntry(r: 20.0, u: 0.18133, v: 0.26846, t: -0.26876),
        TempTableEntry(r: 30.0, u: 0.18208, v: 0.27119, t: -0.28539),
        TempTableEntry(r: 40.0, u: 0.18293, v: 0.27407, t: -0.30470),
        TempTableEntry(r: 50.0, u: 0.18388, v: 0.27709, t: -0.32675),
        TempTableEntry(r: 60.0, u: 0.18494, v: 0.28021, t: -0.35156),
        TempTableEntry(r: 70.0, u: 0.18611, v: 0.28342, t: -0.37915),
        TempTableEntry(r: 80.0, u: 0.18740, v: 0.28668, t: -0.40955),
        TempTableEntry(r: 90.0, u: 0.18880, v: 0.28997, t: -0.44278),
        TempTableEntry(r: 100.0, u: 0.19032, v: 0.29326, t: -0.47888),
        TempTableEntry(r: 125.0, u: 0.19462, v: 0.30141, t: -0.58204),
        TempTableEntry(r: 150.0, u: 0.19962, v: 0.30921, t: -0.70471),
        TempTableEntry(r: 175.0, u: 0.20525, v: 0.31647, t: -0.84901),
        TempTableEntry(r: 200.0, u: 0.21142, v: 0.32312, t: -1.0182),
        TempTableEntry(r: 225.0, u: 0.21807, v: 0.32909, t: -1.2168),
        TempTableEntry(r: 250.0, u: 0.22511, v: 0.33439, t: -1.4512),
        TempTableEntry(r: 275.0, u: 0.23247, v: 0.33904, t: -1.7298),
        TempTableEntry(r: 300.0, u: 0.24010, v: 0.34308, t: -2.0637),
        TempTableEntry(r: 325.0, u: 0.24792, v: 0.34655, t: -2.4681),
        TempTableEntry(r: 350.0, u: 0.25591, v: 0.34951, t: -2.9641),
        TempTableEntry(r: 375.0, u: 0.26400, v: 0.35200, t: -3.5814),
        TempTableEntry(r: 400.0, u: 0.27218, v: 0.35407, t: -4.3633),
        TempTableEntry(r: 425.0, u: 0.28039, v: 0.35577, t: -5.3762),
        TempTableEntry(r: 450.0, u: 0.28863, v: 0.35714, t: -6.7262),
        TempTableEntry(r: 475.0, u: 0.29685, v: 0.35823, t: -8.5955),
        TempTableEntry(r: 500.0, u: 0.30505, v: 0.35907, t: -11.324),
        TempTableEntry(r: 525.0, u: 0.31320, v: 0.35968, t: -15.628),
        TempTableEntry(r: 550.0, u: 0.32129, v: 0.36011, t: -23.325),
        TempTableEntry(r: 575.0, u: 0.32931, v: 0.36038, t: -40.770),
        TempTableEntry(r: 600.0, u: 0.33724, v: 0.36051, t: -116.45),
    ]

    /// Adobe's tint-to-uv-offset scale factor, from `dng_temperature.cpp`.
    private static let tintScale: Double = -3000.0

    /// Convert CIE xy chromaticity to CIE 1960 uv chromaticity (Robertson's
    /// own formula — distinct from the CIE-1976-adjacent `xy_to_uv` used
    /// elsewhere in the codebase for the legacy locus map).
    private static func xyToUvRobertson(_ x: Double, _ y: Double) -> (Double, Double) {
        let denom = -x + 6.0 * y + 1.5
        return (2.0 * x / denom, 3.0 * y / denom)
    }

    /// Convert CIE 1960 uv chromaticity to CIE xy chromaticity (Robertson's
    /// own inverse).
    private static func uvToXyRobertson(_ u: Double, _ v: Double) -> (Double, Double) {
        let denom = u - 4.0 * v + 2.0
        return (1.5 * u / denom, v / denom)
    }

    /// Normalized isotherm direction vector `(du, dv)` for table row `index`.
    private static func isothermUnitVector(_ index: Int) -> (Double, Double) {
        let slope = tempTable[index].t
        let len = (1.0 + slope * slope).squareRoot()
        return (1.0 / len, slope / len)
    }

    /// Convert a CIE xy chromaticity coordinate to ACR's displayed
    /// (temperature in Kelvin, tint) pair.
    ///
    /// Port of `dng_temperature::Set_xy_coord` / Rust's `xy_to_temp_tint`.
    public static func xyToTempTint(_ x: Double, _ y: Double) -> (temperature: Double, tint: Double) {
        let (u, v) = xyToUvRobertson(x, y)

        var lastDt = 0.0

        for index in 1...30 {
            let (du, dv) = isothermUnitVector(index)

            let uu = u - tempTable[index].u
            let vv = v - tempTable[index].v

            let dt = -uu * dv + vv * du

            if dt <= 0.0 || index == 30 {
                let dtPos = -min(dt, 0.0)

                let f: Double = index == 1 ? 0.0 : dtPos / (lastDt + dtPos)

                let temperature =
                    1.0e6 / (tempTable[index - 1].r * f + tempTable[index].r * (1.0 - f))

                let (uu1, vv1) = isothermUnitVector(index - 1)
                let (uu2, vv2) = isothermUnitVector(index)

                let uu3Raw = uu1 * f + uu2 * (1.0 - f)
                let vv3Raw = vv1 * f + vv2 * (1.0 - f)
                let len3 = (uu3Raw * uu3Raw + vv3Raw * vv3Raw).squareRoot()
                let uu3 = uu3Raw / len3
                let vv3 = vv3Raw / len3

                let tint = (uu * uu3 + vv * vv3) * tintScale

                return (temperature, tint)
            }

            lastDt = dt
        }

        // Loop always returns by index == 30 (mirrors Rust's `unreachable!`).
        fatalError("WbDngTemperature.xyToTempTint: loop did not return by index == 30")
    }

    /// Convert ACR's displayed (temperature in Kelvin, tint) pair to a CIE
    /// xy chromaticity coordinate.
    ///
    /// Port of `dng_temperature::Get_xy_coord` / Rust's `temp_tint_to_xy`.
    public static func tempTintToXy(_ temperature: Double, _ tint: Double) -> (x: Double, y: Double) {
        let r = 1.0e6 / temperature

        var index = 29
        for i in 0..<30 where r < tempTable[i + 1].r {
            index = i
            break
        }

        let f = (tempTable[index + 1].r - r) / (tempTable[index + 1].r - tempTable[index].r)

        let u = tempTable[index].u * f + tempTable[index + 1].u * (1.0 - f)
        let v = tempTable[index].v * f + tempTable[index + 1].v * (1.0 - f)

        let (uu1, vv1) = isothermUnitVector(index)
        let (uu2, vv2) = isothermUnitVector(index + 1)

        let uu3Raw = uu1 * f + uu2 * (1.0 - f)
        let vv3Raw = vv1 * f + vv2 * (1.0 - f)
        let len3 = (uu3Raw * uu3Raw + vv3Raw * vv3Raw).squareRoot()
        let uu3 = uu3Raw / len3
        let vv3 = vv3Raw / len3

        let uFinal = u + uu3 * tint / tintScale
        let vFinal = v + vv3 * tint / tintScale

        return uvToXyRobertson(uFinal, vFinal)
    }

    // MARK: - Legacy (pre-#1894) Hernández-Andrés daylight-locus map

    /// Multiplier converting a tint value authored under the legacy 1e-4
    /// uv-per-unit scale (`WbScaleVersion` V1/V3, negated for V2) into the
    /// ACR `kTintScale` (1/3000 uv-per-unit) magnitude used by the legacy
    /// locus map below — mirrors raw-core's `TINT_SCALE_V3_TO_V4`
    /// (`1e-4 / (1/3000) = 0.3`, #1893).
    static let tintScaleV3ToV4: Double = 1e-4 * 3000.0

    /// Scale factor (uv units per tint unit) for the perpendicular-to-locus
    /// tint displacement — ACR's own `kTintScale`, mirrors raw-core's
    /// `TINT_UV_SCALE` (`1/3000`).
    private static let tintUvScale: Double = 1.0 / 3000.0

    /// CCT (Kelvin) → CIE xy chromaticity on the Planckian (blackbody) locus
    /// via Hernández-Andrés et al. 1999. Clamped to [2000K, 25000K].
    /// Mirrors raw-core's `cct_to_xy`.
    private static func cctToXy(_ cct: Double) -> (x: Double, y: Double) {
        let t = min(max(cct, 2000.0), 25000.0)
        let x: Double
        if t <= 4000.0 {
            x = 0.179_910 + 0.877_695_6e3 / t - 0.234_358_9e6 / (t * t) - 0.266_123_9e9 / (t * t * t)
        } else {
            x = 0.240_390 + 0.222_634_7e3 / t + 2.107_037_9e6 / (t * t) - 3.025_846_9e9 / (t * t * t)
        }
        let y = -3.000 * x * x + 2.870 * x - 0.275
        return (x, y)
    }

    /// CIE xy → CIE 1960 UCS (u, v) chromaticity — the CIE-1976-adjacent
    /// (NOT Robertson's own) formula used by the legacy locus map. Mirrors
    /// raw-core's `xy_to_uv`.
    private static func xyToUv(_ x: Double, _ y: Double) -> (u: Double, v: Double) {
        let denom = -2.0 * x + 12.0 * y + 3.0
        return (4.0 * x / denom, 6.0 * y / denom)
    }

    /// CIE 1960 UCS (u, v) → CIE xy chromaticity. Exact inverse of `xyToUv`.
    /// Mirrors raw-core's `uv_to_xy`.
    private static func uvToXy(_ u: Double, _ v: Double) -> (x: Double, y: Double) {
        let denom = 2.0 * u - 8.0 * v + 4.0
        return (3.0 * u / denom, 2.0 * v / denom)
    }

    /// Unit tangent-to-locus direction in CIE 1960 uv space at `cct`, via
    /// central finite difference at `cct ± 50 K`. Mirrors raw-core's
    /// `locus_tangent_uv` — clamps the CENTER first, then steps ±50K, so the
    /// tangent stays well-defined outside [2000, 25000].
    private static func locusTangentUv(_ cct: Double) -> (du: Double, dv: Double) {
        let deltaK = 50.0
        let center = min(max(cct, 2000.0), 25000.0)
        let (xp, yp) = cctToXy(min(center + deltaK, 25000.0))
        let (xm, ym) = cctToXy(max(center - deltaK, 2000.0))
        let (up, vp) = xyToUv(xp, yp)
        let (um, vm) = xyToUv(xm, ym)
        var du = up - um
        var dv = vp - vm
        let len = max((du * du + dv * dv).squareRoot(), 1e-10)
        du /= len
        dv /= len
        return (du, dv)
    }

    /// Unit perpendicular-to-locus direction in CIE 1960 uv space at `cct`,
    /// oriented per the `tintSignPositiveV` convention. Mirrors raw-core's
    /// `tint_perpendicular_axis`.
    private static func tintPerpendicularAxis(_ cct: Double, tintSignPositiveV: Bool) -> (u: Double, v: Double) {
        let (du, dv) = locusTangentUv(cct)
        return tintSignPositiveV ? (dv, -du) : (-dv, du)
    }

    /// Apply a tint displacement perpendicular to the Planckian locus in CIE
    /// 1960 uv space, matching the DNG / ACR convention. Mirrors raw-core's
    /// `apply_tint_perpendicular`.
    private static func applyTintPerpendicular(
        x: Double, y: Double, cct: Double, tint: Double, tintSignPositiveV: Bool
    ) -> (x: Double, y: Double) {
        let (perpU, perpV) = tintPerpendicularAxis(cct, tintSignPositiveV: tintSignPositiveV)
        let (u0, v0) = xyToUv(x, y)
        let displacement = tint * tintUvScale
        let u1 = u0 + displacement * perpU
        let v1 = v0 + displacement * perpV
        return uvToXy(u1, v1)
    }

    /// The pre-#1894 (≤ V4) forward map — Hernández-Andrés daylight locus +
    /// perpendicular uv displacement at the version's tint magnitude. Kept
    /// ONLY so values authored under the legacy scales can be re-expressed
    /// through the physical chromaticity they encoded (`authoredPairToV5`).
    /// Mirrors raw-core's `legacy_slider_source_xy`.
    private static func legacySliderSourceXy(temperature: Double, tint: Double) -> (x: Double, y: Double) {
        let (x, y) = cctToXy(temperature)
        return applyTintPerpendicular(x: x, y: y, cct: temperature, tint: tint, tintSignPositiveV: true)
    }

    // MARK: - authoredPairToV5

    /// Re-express an explicitly-authored `(temperature, tint)` pair in the
    /// current (V5, #1894) Robertson value mapping, preserving the physical
    /// chromaticity it encoded when written. Mirrors raw-core's
    /// `authored_pair_to_v5`:
    ///
    /// - **V1/V3** — ACR-direction axis at the legacy 1e-4 uv-per-unit
    ///   scale: rescale the tint by `tintScaleV3ToV4` (0.3), evaluate the
    ///   legacy (Hernández-Andrés + perpendicular) map, invert through
    ///   Robertson.
    /// - **V2** — the inverted-axis legacy scale: negate AND rescale, then
    ///   the same xy round-trip.
    /// - **V4** — ACR magnitude but the legacy locus map (#1893, never in a
    ///   released build): straight xy round-trip.
    /// - **V5** — Robertson-native: passes through.
    public static func authoredPairToV5(
        temperature: Double, tint: Double, version: Int
    ) -> (temperature: Double, tint: Double) {
        let legacyTint: Double
        switch version {
        case 1, 3: legacyTint = tint * tintScaleV3ToV4
        case 2:    legacyTint = -tint * tintScaleV3ToV4
        case 4:    legacyTint = tint
        default:   return (temperature, tint)
        }
        let (x, y) = legacySliderSourceXy(temperature: temperature, tint: legacyTint)
        return xyToTempTint(x, y)
    }
}
