// CIEDE2000.swift — Swift port of compare_images.py for the UITest harness.
//
// Mirrors `colour.delta_E(method="CIE 2000")` from the Python helper at
// src/scripts/compare_images.py. Cross-validated to ≤ 1e-3 ΔE in
// CIEDE2000Tests against a fixed PNG pair so the harness reports
// numerically the same metric the Rust color-pipeline harness reports.
//
// Pipeline:
//   1. sRGB bytes → linear sRGB (gamma decode, sRGB EOTF).
//   2. Linear sRGB → XYZ via the sRGB → XYZ D65 matrix.
//   3. XYZ → Lab under D65 2° observer (CIE Lab math; standard f(t)
//      with the (6/29)^3 piecewise threshold).
//   4. CIEDE2000 between two Lab triples, per Sharma/Wu/Dalal (2005).
//
// Inputs are PNG-decoded RGBA8 buffers (Data) at the same width/height;
// alpha is ignored (same as the Python reference, which drops alpha via
// `Image.convert("RGB")`).
//
// See docs/superpowers/plans/2026-04-25-xcuitest-visual-harness.md
// Task 4 for the cross-validation procedure.

import Foundation

/// Per-channel bias and CIEDE2000 metrics, matching the JSON output of
/// `compare_images.py`. `bias_*` are linear-light differences in [0, 1]
/// after the gamma decode — Python's `(cand - ref).mean()` is computed
/// on the [0,1]-normalised but still gamma-encoded sRGB tensor; we
/// follow that convention so the numbers compare directly.
struct CIEDE2000Result: Equatable {
    let meanDeltaE: Double
    let p95DeltaE: Double
    let maxDeltaE: Double
    let biasR: Double
    let biasG: Double
    let biasB: Double
    let nPixels: Int
}

enum CIEDE2000 {
    /// Compare two RGBA8 buffers (interleaved, sRGB-encoded). Returns
    /// `nil` if the buffer sizes don't match. Per-pixel ΔE is computed
    /// in linear-light Lab space; the bias values stay in gamma-encoded
    /// [0,1] sRGB to mirror the Python reference's (cand-ref).mean().
    static func compare(candidateRGBA: [UInt8],
                        referenceRGBA: [UInt8],
                        width: Int,
                        height: Int) -> CIEDE2000Result? {
        let n = width * height
        guard candidateRGBA.count == n * 4,
              referenceRGBA.count == n * 4 else { return nil }

        var deltas = [Double]()
        deltas.reserveCapacity(n)
        // Bias is summed in Float to mirror compare_images.py's float32
        // tensor; Double accumulation diverges at the 1e-6 level over
        // ~4k pixels which is enough to fail the cross-validation gate.
        var sumBiasR: Float = 0
        var sumBiasG: Float = 0
        var sumBiasB: Float = 0

        for i in 0..<n {
            let off = i * 4
            // sRGB-encoded [0,1] in Float (32-bit) for the bias diff —
            // matches compare_images.py's `np.float32` array. Lab math
            // upcasts to Double for the precision colour.delta_E uses.
            let cR_f = Float(candidateRGBA[off]) / 255.0
            let cG_f = Float(candidateRGBA[off + 1]) / 255.0
            let cB_f = Float(candidateRGBA[off + 2]) / 255.0
            let rR_f = Float(referenceRGBA[off]) / 255.0
            let rG_f = Float(referenceRGBA[off + 1]) / 255.0
            let rB_f = Float(referenceRGBA[off + 2]) / 255.0

            sumBiasR += (cR_f - rR_f)
            sumBiasG += (cG_f - rG_f)
            sumBiasB += (cB_f - rB_f)

            // sRGB → linear → XYZ → Lab in Double, both sides.
            let cR = Double(cR_f), cG = Double(cG_f), cB = Double(cB_f)
            let rR = Double(rR_f), rG = Double(rG_f), rB = Double(rB_f)
            let cLab = labFromSRGB(r: cR, g: cG, b: cB)
            let rLab = labFromSRGB(r: rR, g: rG, b: rB)
            deltas.append(deltaE2000(lab1: cLab, lab2: rLab))
        }

        deltas.sort()
        let mean = deltas.reduce(0, +) / Double(n)
        // numpy.percentile default `linear` interpolation:
        //   index = (n - 1) * 0.95
        //   p = floor(index); val = arr[p] + (arr[p+1] - arr[p]) * (index - p)
        let p95Index = Double(n - 1) * 0.95
        let lo = Int(p95Index.rounded(.down))
        let hi = min(lo + 1, n - 1)
        let frac = p95Index - Double(lo)
        let p95 = deltas[lo] + (deltas[hi] - deltas[lo]) * frac
        let maxDE = deltas[n - 1]

        return CIEDE2000Result(
            meanDeltaE: mean,
            p95DeltaE: p95,
            maxDeltaE: maxDE,
            biasR: Double(sumBiasR / Float(n)),
            biasG: Double(sumBiasG / Float(n)),
            biasB: Double(sumBiasB / Float(n)),
            nPixels: n
        )
    }

    // MARK: - Color math

    /// sRGB EOTF (gamma decode) per IEC 61966-2-1.
    private static func srgbToLinear(_ s: Double) -> Double {
        if s <= 0.04045 { return s / 12.92 }
        return pow((s + 0.055) / 1.055, 2.4)
    }

    /// Linear sRGB → XYZ. Matches the 4-decimal matrix used by
    /// colour-science's `colour.sRGB_to_XYZ` (the package rounds the
    /// canonical BT.709 matrix to 4 decimals before applying it). Using
    /// the more precise 7-decimal coefficients here produces ~0.005 ΔE
    /// drift on a single pixel — over 1e-3 tolerance — so we mirror the
    /// reference's rounding.
    private static func linearRGBToXYZ(r: Double, g: Double, b: Double) -> (x: Double, y: Double, z: Double) {
        let x = 0.4124 * r + 0.3576 * g + 0.1805 * b
        let y = 0.2126 * r + 0.7152 * g + 0.0722 * b
        let z = 0.0193 * r + 0.1192 * g + 0.9505 * b
        return (x, y, z)
    }

    /// CIE D65 derived from xy = (0.3127, 0.329) via xy_to_XYZ — the
    /// values colour-science's XYZ_to_Lab uses by default. Different
    /// from the more common (0.95047, 1.0, 1.08883) reference white by
    /// a few thousandths in z — enough to throw the ΔE cross-validation
    /// past 1e-3 if mismatched.
    private static let xnD65 = 0.95045593
    private static let ynD65 = 1.00000
    private static let znD65 = 1.08905775

    /// Standard CIE Lab f(t).
    private static func labF(_ t: Double) -> Double {
        // (6/29)^3 = 216/24389 ≈ 0.008856
        let delta: Double = 6.0 / 29.0
        if t > pow(delta, 3) {
            return pow(t, 1.0 / 3.0)
        }
        return t / (3.0 * delta * delta) + 4.0 / 29.0
    }

    /// XYZ → CIE Lab.
    private static func xyzToLab(x: Double, y: Double, z: Double) -> (L: Double, a: Double, b: Double) {
        let fx = labF(x / xnD65)
        let fy = labF(y / ynD65)
        let fz = labF(z / znD65)
        let L = 116.0 * fy - 16.0
        let a = 500.0 * (fx - fy)
        let b = 200.0 * (fy - fz)
        return (L, a, b)
    }

    /// sRGB-encoded [0,1] → Lab.
    private static func labFromSRGB(r: Double, g: Double, b: Double) -> (L: Double, a: Double, b: Double) {
        let lr = srgbToLinear(r)
        let lg = srgbToLinear(g)
        let lb = srgbToLinear(b)
        let xyz = linearRGBToXYZ(r: lr, g: lg, b: lb)
        return xyzToLab(x: xyz.x, y: xyz.y, z: xyz.z)
    }

    // MARK: - CIEDE2000

    /// CIEDE2000 between two Lab triples. Reference: Sharma, Wu, Dalal,
    /// "The CIEDE2000 Color-Difference Formula: Implementation Notes,
    /// Supplementary Test Data, and Mathematical Observations" (2005).
    private static func deltaE2000(lab1: (L: Double, a: Double, b: Double),
                                   lab2: (L: Double, a: Double, b: Double)) -> Double {
        let (L1, a1, b1) = lab1
        let (L2, a2, b2) = lab2

        // Weighting factors kL=kC=kH=1 (graphic-arts default; what colour
        // delta_E uses unless told otherwise).
        let kL: Double = 1.0
        let kC: Double = 1.0
        let kH: Double = 1.0

        let C1ab = sqrt(a1 * a1 + b1 * b1)
        let C2ab = sqrt(a2 * a2 + b2 * b2)
        let Cab_bar = 0.5 * (C1ab + C2ab)

        let C7 = pow(Cab_bar, 7.0)
        let G = 0.5 * (1.0 - sqrt(C7 / (C7 + pow(25.0, 7.0))))

        let a1p = (1.0 + G) * a1
        let a2p = (1.0 + G) * a2

        let C1p = sqrt(a1p * a1p + b1 * b1)
        let C2p = sqrt(a2p * a2p + b2 * b2)

        // Hue angles in degrees, clamped to [0, 360).
        func hp(_ y: Double, _ x: Double) -> Double {
            if y == 0 && x == 0 { return 0 }
            var deg = atan2(y, x) * 180.0 / .pi
            if deg < 0 { deg += 360 }
            return deg
        }
        let h1p = hp(b1, a1p)
        let h2p = hp(b2, a2p)

        let dLp = L2 - L1
        let dCp = C2p - C1p

        var dhp: Double
        if C1p * C2p == 0 {
            dhp = 0
        } else {
            let diff = h2p - h1p
            if abs(diff) <= 180 {
                dhp = diff
            } else if diff > 180 {
                dhp = diff - 360
            } else {
                dhp = diff + 360
            }
        }
        let dHp = 2.0 * sqrt(C1p * C2p) * sin(dhp * .pi / 360.0)

        let Lp_bar = 0.5 * (L1 + L2)
        let Cp_bar = 0.5 * (C1p + C2p)

        var hp_bar: Double
        if C1p * C2p == 0 {
            hp_bar = h1p + h2p
        } else if abs(h1p - h2p) <= 180 {
            hp_bar = 0.5 * (h1p + h2p)
        } else if h1p + h2p < 360 {
            hp_bar = 0.5 * (h1p + h2p + 360)
        } else {
            hp_bar = 0.5 * (h1p + h2p - 360)
        }

        let T = 1.0
            - 0.17 * cos((hp_bar - 30.0) * .pi / 180.0)
            + 0.24 * cos((2.0 * hp_bar) * .pi / 180.0)
            + 0.32 * cos((3.0 * hp_bar + 6.0) * .pi / 180.0)
            - 0.20 * cos((4.0 * hp_bar - 63.0) * .pi / 180.0)

        let dTheta = 30.0 * exp(-pow((hp_bar - 275.0) / 25.0, 2.0))

        let Cp7 = pow(Cp_bar, 7.0)
        let Rc = 2.0 * sqrt(Cp7 / (Cp7 + pow(25.0, 7.0)))

        let Lp50sq = pow(Lp_bar - 50.0, 2.0)
        let Sl = 1.0 + (0.015 * Lp50sq) / sqrt(20.0 + Lp50sq)
        let Sc = 1.0 + 0.045 * Cp_bar
        let Sh = 1.0 + 0.015 * Cp_bar * T

        let Rt = -sin(2.0 * dTheta * .pi / 180.0) * Rc

        let termL = dLp / (kL * Sl)
        let termC = dCp / (kC * Sc)
        let termH = dHp / (kH * Sh)

        return sqrt(termL * termL
                    + termC * termC
                    + termH * termH
                    + Rt * termC * termH)
    }
}
