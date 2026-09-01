// XmpWbScale — WB slider-scale version resolution (#1780/#1875/#1893/#1894/#2670).
//
// Windows never ported the legacy-scale-to-V5 normalization Swift and Web
// perform on load: a `papp:WbScaleVersion` stamp of 2, 3, or 4 was stored
// verbatim (never clamped to {1, 5}) and `crs:Temperature`/`crs:Tint` were
// never rescaled, so a sidecar written under an old scale rendered with the
// wrong white balance on Windows while Apple/Web resolved the correct
// physical chromaticity. See `docs/xmp-canonical-format.md` §
// "WB slider-scale versioning" and issue #2670.
//
// Faithful C# port of raw-core's `stages::white_balance_v5` /
// `color::dng_temperature` (mirrored 1:1 by the TypeScript reference at
// `src/web/projects/maple-common/src/lib/xmp/xmp-wb-scale.ts` and
// `wb-dng-temperature.ts`, and by Swift's `WbDngTemperature.swift`
// `authoredPairToV5`). Only the load direction (`XyToTempTint`, legacy →
// V5) is needed here — Windows only ever reads a legacy-stamped pair, never
// writes one, so the inverse (`tempTintToXy`/`TempTintToXy`) has no caller
// on this platform and is intentionally not ported (YAGNI).
using System;

namespace Maple.WinUI.Services.Xmp
{
    internal static class XmpWbScale
    {
        // ── Legacy (≤V4) value-domain tint scale ────────────────────────────

        /// <summary>
        /// Legacy (V1/V3, 1e-4 uv-per-unit) → V4/V5 (kTintScale, 1/3000 uv
        /// per unit) tint magnitude ratio — mirrors raw-core's
        /// `TINT_SCALE_V3_TO_V4` (== 1e-4 * 3000.0 == 0.3).
        /// </summary>
        private const double TintScaleV3ToV4 = 0.3;

        /// <summary>
        /// Perpendicular-to-locus tint displacement scale (uv units per
        /// tint unit) in the LEGACY (pre-#1894) value mapping — Adobe's own
        /// `dng_temperature.cpp` `kTintScale`, mirrors raw-core's
        /// `TINT_UV_SCALE`.
        /// </summary>
        private const double TintUvScale = 1.0 / 3000.0;

        // ── Robertson (V5) isotherm table — dng_temperature.rs ──────────────

        /// <summary>One row of the Robertson 1968 correlated-color-temperature table.</summary>
        private readonly record struct TempTableEntry(double R, double U, double V, double T);

        /// <summary>
        /// The Robertson 1968 table, as shipped in Adobe DNG SDK's
        /// `dng_temperature.cpp`. 31 rows, `R` (reciprocal temperature,
        /// "mired") from 0 to 600.
        /// </summary>
        private static readonly TempTableEntry[] TempTable =
        {
            new(0.0, 0.18006, 0.26352, -0.24341),
            new(10.0, 0.18066, 0.26589, -0.25479),
            new(20.0, 0.18133, 0.26846, -0.26876),
            new(30.0, 0.18208, 0.27119, -0.28539),
            new(40.0, 0.18293, 0.27407, -0.3047),
            new(50.0, 0.18388, 0.27709, -0.32675),
            new(60.0, 0.18494, 0.28021, -0.35156),
            new(70.0, 0.18611, 0.28342, -0.37915),
            new(80.0, 0.1874, 0.28668, -0.40955),
            new(90.0, 0.1888, 0.28997, -0.44278),
            new(100.0, 0.19032, 0.29326, -0.47888),
            new(125.0, 0.19462, 0.30141, -0.58204),
            new(150.0, 0.19962, 0.30921, -0.70471),
            new(175.0, 0.20525, 0.31647, -0.84901),
            new(200.0, 0.21142, 0.32312, -1.0182),
            new(225.0, 0.21807, 0.32909, -1.2168),
            new(250.0, 0.22511, 0.33439, -1.4512),
            new(275.0, 0.23247, 0.33904, -1.7298),
            new(300.0, 0.2401, 0.34308, -2.0637),
            new(325.0, 0.24792, 0.34655, -2.4681),
            new(350.0, 0.25591, 0.34951, -2.9641),
            new(375.0, 0.264, 0.352, -3.5814),
            new(400.0, 0.27218, 0.35407, -4.3633),
            new(425.0, 0.28039, 0.35577, -5.3762),
            new(450.0, 0.28863, 0.35714, -6.7262),
            new(475.0, 0.29685, 0.35823, -8.5955),
            new(500.0, 0.30505, 0.35907, -11.324),
            new(525.0, 0.3132, 0.35968, -15.628),
            new(550.0, 0.32129, 0.36011, -23.325),
            new(575.0, 0.32931, 0.36038, -40.77),
            new(600.0, 0.33724, 0.36051, -116.45),
        };

        /// <summary>
        /// Adobe's tint-to-uv-offset scale factor, from `dng_temperature.cpp`.
        /// Negative: a positive tint value is a NEGATIVE multiple of the
        /// isotherm unit vector's `(u, v)` displacement.
        /// </summary>
        private const double TintScale = -3000.0;

        private static (double U, double V) XyToUv(double x, double y)
        {
            var denom = -x + 6.0 * y + 1.5;
            return (2.0 * x / denom, 3.0 * y / denom);
        }

        // The Robertson-domain inverse (uv -> xy) has no caller: Windows
        // only ever loads a legacy-stamped pair (XyToTempTint, the forward
        // direction), never writes one (see the file header's YAGNI note),
        // so it is intentionally not ported here (#2670).
        // `LegacyUvToXy` below is the LEGACY-domain inverse and is used.

        private static (double Du, double Dv) IsothermUnitVector(int index)
        {
            var slope = TempTable[index].T;
            var len = Math.Sqrt(1.0 + slope * slope);
            return (1.0 / len, slope / len);
        }

        /// <summary>
        /// Convert a CIE xy chromaticity coordinate to ACR's displayed
        /// (temperature in Kelvin, tint) pair. Port of
        /// `dng_temperature::Set_xy_coord` / raw-core's `xy_to_temp_tint`.
        /// </summary>
        private static (double Temperature, double Tint) XyToTempTint(double x, double y)
        {
            var (u, v) = XyToUv(x, y);
            var lastDt = 0.0;

            for (var index = 1; index <= 30; index++)
            {
                var (du, dv) = IsothermUnitVector(index);
                var uu = u - TempTable[index].U;
                var vv = v - TempTable[index].V;
                var dt = -uu * dv + vv * du;

                if (dt <= 0.0 || index == 30)
                {
                    var dtPos = -Math.Min(dt, 0.0);
                    var f = index == 1 ? 0.0 : dtPos / (lastDt + dtPos);
                    var temperature = 1.0e6 / (TempTable[index - 1].R * f + TempTable[index].R * (1.0 - f));

                    var (uu1, vv1) = IsothermUnitVector(index - 1);
                    var (uu2, vv2) = IsothermUnitVector(index);
                    var uu3Raw = uu1 * f + uu2 * (1.0 - f);
                    var vv3Raw = vv1 * f + vv2 * (1.0 - f);
                    var len3 = Math.Sqrt(uu3Raw * uu3Raw + vv3Raw * vv3Raw);
                    var uu3 = uu3Raw / len3;
                    var vv3 = vv3Raw / len3;

                    var tint = (uu * uu3 + vv * vv3) * TintScale;
                    return (temperature, tint);
                }

                lastDt = dt;
            }

            // Unreachable: the loop always returns at index == 30 (mirrors
            // the Rust `unreachable!("loop always returns by index == 30")`).
            throw new InvalidOperationException(
                "XyToTempTint: loop exited without returning (unreachable)");
        }

        // ── Legacy (≤V4) Hernández-Andrés locus map ──────────────────────────
        //
        // Kept ONLY so an authored ≤V4 pair can be re-expressed through the
        // physical chromaticity it encoded when written (`AuthoredPairToV5`
        // below) — it is not evaluated by any live V5 render path.

        /// <summary>
        /// CCT (Kelvin) → CIE xy chromaticity on the Planckian (blackbody)
        /// locus, via Hernández-Andrés et al. 1999. Valid range
        /// 1667K-25000K; clamped to [2000K, 25000K] — mirrors raw-core's
        /// `cct_to_xy`.
        /// </summary>
        private static (double X, double Y) CctToXy(double cctIn)
        {
            var t = Math.Min(Math.Max(cctIn, 2000.0), 25000.0);
            var x = t <= 4000.0
                ? 0.17991 + 877.6956 / t - 234358.9 / (t * t) - 266123900.0 / (t * t * t)
                : 0.24039 + 222.6347 / t + 2107037.9 / (t * t) - 3025846900.0 / (t * t * t);
            var y = -3.0 * x * x + 2.87 * x - 0.275;
            return (x, y);
        }

        /// <summary>CIE xy → CIE 1960 UCS (u, v), the legacy map's metric.</summary>
        private static (double U, double V) LegacyXyToUv(double x, double y)
        {
            var denom = -2.0 * x + 12.0 * y + 3.0;
            return (4.0 * x / denom, 6.0 * y / denom);
        }

        /// <summary>CIE 1960 UCS (u, v) → CIE xy — exact inverse of <see cref="LegacyXyToUv"/>.</summary>
        private static (double X, double Y) LegacyUvToXy(double u, double v)
        {
            var denom = 2.0 * u - 8.0 * v + 4.0;
            return (3.0 * u / denom, 2.0 * v / denom);
        }

        /// <summary>
        /// Unit tangent-to-locus direction in CIE 1960 uv space at
        /// <paramref name="cct"/>, via central finite difference at
        /// `cct ± 50K`, center-clamped to [2000, 25000] before stepping.
        /// </summary>
        private static (double Du, double Dv) LocusTangentUv(double cct)
        {
            const double deltaK = 50.0;
            var center = Math.Min(Math.Max(cct, 2000.0), 25000.0);
            var (xp, yp) = CctToXy(Math.Min(center + deltaK, 25000.0));
            var (xm, ym) = CctToXy(Math.Max(center - deltaK, 2000.0));
            var (up, vp) = LegacyXyToUv(xp, yp);
            var (um, vm) = LegacyXyToUv(xm, ym);
            var rawDu = up - um;
            var rawDv = vp - vm;
            var len = Math.Max(Math.Sqrt(rawDu * rawDu + rawDv * rawDv), 1e-10);
            return (rawDu / len, rawDv / len);
        }

        /// <summary>
        /// Unit perpendicular-to-locus direction in CIE 1960 uv space at
        /// <paramref name="cct"/>. <paramref name="tintSignPositiveV"/>
        /// selects which of the two 90°-rotated candidates to use;
        /// <see cref="AuthoredPairToV5"/> always passes true.
        /// </summary>
        private static (double U, double V) TintPerpendicularAxis(double cct, bool tintSignPositiveV)
        {
            var (du, dv) = LocusTangentUv(cct);
            return tintSignPositiveV ? (dv, -du) : (-dv, du);
        }

        /// <summary>
        /// Apply a tint displacement perpendicular to the Planckian locus
        /// in CIE 1960 uv space.
        /// </summary>
        private static (double X, double Y) ApplyTintPerpendicular(
            double x, double y, double cct, double tint, bool tintSignPositiveV)
        {
            var (perpU, perpV) = TintPerpendicularAxis(cct, tintSignPositiveV);
            var (u0, v0) = LegacyXyToUv(x, y);
            var displacement = tint * TintUvScale;
            return LegacyUvToXy(u0 + displacement * perpU, v0 + displacement * perpV);
        }

        /// <summary>
        /// The pre-#1894 (≤V4) forward map — Hernández-Andrés daylight
        /// locus + perpendicular uv displacement at the version's tint
        /// magnitude. Kept ONLY so values authored under the legacy scales
        /// can be re-expressed through the physical chromaticity they
        /// encoded (<see cref="AuthoredPairToV5"/>).
        /// </summary>
        private static (double X, double Y) LegacySliderSourceXy(double temperature, double tint)
        {
            var (x, y) = CctToXy(temperature);
            return ApplyTintPerpendicular(x, y, temperature, tint, true);
        }

        /// <summary>
        /// Rescale an authored tint into the legacy map's `kTintScale`
        /// magnitude, per the version's axis/scale — mirrors the match arm
        /// in raw-core's `authored_pair_to_v5` (V5 is handled by the
        /// caller, not here).
        /// </summary>
        private static double LegacyTintForVersion(double tint, int version) => version switch
        {
            2 => -tint * TintScaleV3ToV4,
            4 => tint,
            _ => tint * TintScaleV3ToV4, // V1 | V3
        };

        /// <summary>
        /// Re-express an explicitly-authored `(temperature, tint)` pair in
        /// the current (V5, #1894) Robertson value mapping, preserving the
        /// physical chromaticity it encoded when written. Faithful port of
        /// raw-core's `authored_pair_to_v5`:
        ///
        /// - V1/V3 — ACR-direction axis at the legacy 1e-4 uv-per-unit
        ///   scale: rescale the tint by <see cref="TintScaleV3ToV4"/> (0.3),
        ///   evaluate the legacy (Hernández-Andrés + perpendicular) map,
        ///   invert through Robertson.
        /// - V2 — the inverted-axis legacy scale: negate AND rescale, then
        ///   the same xy round-trip.
        /// - V4 — ACR magnitude but the legacy locus map (#1893, never in a
        ///   released build): straight xy round-trip.
        /// - V5 — Robertson-native: passes through.
        ///
        /// <paramref name="version"/> is the SOURCE stamp that was actually
        /// authored (1-5) — distinct from the clamped model version stored
        /// on <see cref="XmpSidecarDocument.WbScaleVersion"/>, which is
        /// always 1 or 5.
        /// </summary>
        public static (double Temperature, double Tint) AuthoredPairToV5(
            double temperature, double tint, int version)
        {
            if (version == 5) return (temperature, tint);
            var legacyTint = LegacyTintForVersion(tint, version);
            var (x, y) = LegacySliderSourceXy(temperature, legacyTint);
            return XyToTempTint(x, y);
        }
    }
}
