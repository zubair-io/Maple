// CIEDE2000.swift — Swift port of compare_images.py for the SwiftPM visual harness.
//
// Mirrors `colour.delta_E(method="CIE 2000")` from the Python helper at
// src/scripts/compare_images.py. Cross-validated to ≤ 1e-3 ΔE in
// the UI CIEDE2000Tests against fixed PNG pairs so the harness reports
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
// See .archived-plans/plans/2026-04-25-xcuitest-visual-harness.md
// Task 4 for the cross-validation procedure.

import Foundation

/// Per-channel bias and CIEDE2000 metrics, matching the JSON output of
/// `compare_images.py`. Bias uses differences between Float-normalized,
/// gamma-encoded sRGB samples, accumulated and averaged in Double.
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
  static func compare(
    candidateRGBA: [UInt8],
    referenceRGBA: [UInt8],
    width: Int,
    height: Int
  ) -> CIEDE2000Result? {
    let n = width * height
    guard candidateRGBA.count == n * 4,
      referenceRGBA.count == n * 4
    else { return nil }

    var deltas = [Double]()
    deltas.reserveCapacity(n)
    // Preserve the reference's Float residuals, but accumulate in
    // Double so large canvases do not acquire size/order drift (#4667).
    var sumBiasR: Double = 0
    var sumBiasG: Double = 0
    var sumBiasB: Double = 0

    for i in 0..<n {
      let off = i * 4
      // sRGB-encoded [0,1] in Float (32-bit) for the bias diff —
      // matches compare_images.py's `np.float32` array. Lab math
      // upcasts to Double for the precision colour.delta_E uses.
      let cRFloat = Float(candidateRGBA[off]) / 255.0
      let cGFloat = Float(candidateRGBA[off + 1]) / 255.0
      let cBFloat = Float(candidateRGBA[off + 2]) / 255.0
      let rRFloat = Float(referenceRGBA[off]) / 255.0
      let rGFloat = Float(referenceRGBA[off + 1]) / 255.0
      let rBFloat = Float(referenceRGBA[off + 2]) / 255.0

      sumBiasR += Double(cRFloat - rRFloat)
      sumBiasG += Double(cGFloat - rGFloat)
      sumBiasB += Double(cBFloat - rBFloat)

      // sRGB → linear → XYZ → Lab in Double, both sides.
      let cR = Double(cRFloat)
      let cG = Double(cGFloat)
      let cB = Double(cBFloat)
      let rR = Double(rRFloat)
      let rG = Double(rGFloat)
      let rB = Double(rBFloat)
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
      biasR: sumBiasR / Double(n),
      biasG: sumBiasG / Double(n),
      biasB: sumBiasB / Double(n),
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
  private static func linearRGBToXYZ(r: Double, g: Double, b: Double) -> (
    x: Double, y: Double, z: Double
  ) {
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
  private static func xyzToLab(x: Double, y: Double, z: Double) -> (L: Double, a: Double, b: Double)
  {
    let fx = labF(x / xnD65)
    let fy = labF(y / ynD65)
    let fz = labF(z / znD65)
    let lightness = 116.0 * fy - 16.0
    let a = 500.0 * (fx - fy)
    let b = 200.0 * (fy - fz)
    return (lightness, a, b)
  }

  /// sRGB-encoded [0,1] → Lab.
  private static func labFromSRGB(r: Double, g: Double, b: Double) -> (
    L: Double, a: Double, b: Double
  ) {
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
  private static func deltaE2000(
    lab1: (L: Double, a: Double, b: Double),
    lab2: (L: Double, a: Double, b: Double)
  ) -> Double {
    let (L1, a1, b1) = lab1
    let (L2, a2, b2) = lab2

    // Weighting factors kL=kC=kH=1 (graphic-arts default; what colour
    // delta_E uses unless told otherwise).
    let kL: Double = 1.0
    let kC: Double = 1.0
    let kH: Double = 1.0

    let c1ab = sqrt(a1 * a1 + b1 * b1)
    let c2ab = sqrt(a2 * a2 + b2 * b2)
    let cabMean = 0.5 * (c1ab + c2ab)

    let c7 = pow(cabMean, 7.0)
    let g = 0.5 * (1.0 - sqrt(c7 / (c7 + pow(25.0, 7.0))))

    let a1p = (1.0 + g) * a1
    let a2p = (1.0 + g) * a2

    let c1p = sqrt(a1p * a1p + b1 * b1)
    let c2p = sqrt(a2p * a2p + b2 * b2)

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
    let dCp = c2p - c1p

    var dhp: Double
    if c1p * c2p == 0 {
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
    let dHp = 2.0 * sqrt(c1p * c2p) * sin(dhp * .pi / 360.0)

    let lpMean = 0.5 * (L1 + L2)
    let cpMean = 0.5 * (c1p + c2p)

    var hpMean: Double
    if c1p * c2p == 0 {
      hpMean = h1p + h2p
    } else if abs(h1p - h2p) <= 180 {
      hpMean = 0.5 * (h1p + h2p)
    } else if h1p + h2p < 360 {
      hpMean = 0.5 * (h1p + h2p + 360)
    } else {
      hpMean = 0.5 * (h1p + h2p - 360)
    }

    let t =
      1.0
      - 0.17 * cos((hpMean - 30.0) * .pi / 180.0)
      + 0.24 * cos((2.0 * hpMean) * .pi / 180.0)
      + 0.32 * cos((3.0 * hpMean + 6.0) * .pi / 180.0)
      - 0.20 * cos((4.0 * hpMean - 63.0) * .pi / 180.0)

    let dTheta = 30.0 * exp(-pow((hpMean - 275.0) / 25.0, 2.0))

    let cp7 = pow(cpMean, 7.0)
    let rc = 2.0 * sqrt(cp7 / (cp7 + pow(25.0, 7.0)))

    let lp50Squared = pow(lpMean - 50.0, 2.0)
    let sl = 1.0 + (0.015 * lp50Squared) / sqrt(20.0 + lp50Squared)
    let sc = 1.0 + 0.045 * cpMean
    let sh = 1.0 + 0.015 * cpMean * t

    let rt = -sin(2.0 * dTheta * .pi / 180.0) * rc

    let termL = dLp / (kL * sl)
    let termC = dCp / (kC * sc)
    let termH = dHp / (kH * sh)

    return sqrt(
      termL * termL
        + termC * termC
        + termH * termH
        + rt * termC * termH)
  }
}
