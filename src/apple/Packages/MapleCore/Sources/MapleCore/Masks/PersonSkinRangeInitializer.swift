import CoreGraphics
import Foundation

enum PersonSkinRangeInitializer {
  static let minimumDefaultCoverageWeight: Double = 0.005

  static func initialRange(
    image: CGImage,
    maskWidth: Int,
    maskHeight: Int,
    maskBytes: [UInt8]
  ) -> RangeRefinement {
    guard
      let sample = adaptiveSampleIfDefaultInert(
        image: image,
        maskWidth: maskWidth,
        maskHeight: maskHeight,
        maskBytes: maskBytes
      )
    else {
      return .skinTone
    }
    return RangeRefinement.skinTone.seeded(with: sample)
  }

  static func adaptiveSampleIfDefaultInert(
    image: CGImage,
    maskWidth: Int,
    maskHeight: Int,
    maskBytes: [UInt8]
  ) -> MaskRangeSample? {
    guard maskWidth > 0, maskHeight > 0, maskBytes.count == maskWidth * maskHeight,
      let rgba = renderSRGBBytes(image: image, width: maskWidth, height: maskHeight)
    else {
      return nil
    }

    let step = max(1, min(maskWidth, maskHeight) / 256)
    var defaultWeightSum = 0.0
    var hues = [Double]()
    var chromas = [Double]()
    var lightnesses = [Double]()
    var sumSin = 0.0
    var sumCos = 0.0

    for y in stride(from: 0, to: maskHeight, by: step) {
      let rowOffset = y * maskWidth
      for x in stride(from: 0, to: maskWidth, by: step) {
        let index = rowOffset + x
        guard maskBytes[index] >= 128 else { continue }
        let pixelOffset = index * 4
        let r = srgbToLinear(Double(rgba[pixelOffset]) / 255.0)
        let g = srgbToLinear(Double(rgba[pixelOffset + 1]) / 255.0)
        let b = srgbToLinear(Double(rgba[pixelOffset + 2]) / 255.0)
        let (l, okA, okB) = linearSRGBToOklab(r: r, g: g, b: b)
        let chroma = hypot(okA, okB)
        guard l.isFinite, chroma.isFinite, l >= 0.20, l <= 0.95, chroma >= 0.015 else {
          continue
        }
        let hueDeg = atan2(okB, okA) * 180.0 / .pi
        guard (-55.0...95.0).contains(hueDeg) else { continue }
        defaultWeightSum += rangeWeight(.skinTone, l: l, chroma: chroma, hueDeg: hueDeg)
        hues.append(hueDeg)
        chromas.append(chroma)
        lightnesses.append(l)
        let rad = hueDeg * .pi / 180.0
        sumSin += sin(rad)
        sumCos += cos(rad)
      }
    }

    guard !hues.isEmpty else { return nil }
    let meanDefaultWeight = defaultWeightSum / Double(hues.count)
    guard meanDefaultWeight < minimumDefaultCoverageWeight else { return nil }

    let meanHue = atan2(sumSin, sumCos) * 180.0 / .pi
    let sortedDeltas = hues.map { signedCircularDeltaDeg($0, meanHue) }.sorted()
    let medianHue = wrapHueDeg(meanHue + sortedDeltas[sortedDeltas.count / 2])
    let sortedChromas = chromas.sorted()
    let sortedLightnesses = lightnesses.sorted()
    let medianChroma = sortedChromas[sortedChromas.count / 2]
    let medianL = sortedLightnesses[sortedLightnesses.count / 2]

    return MaskRangeSample(
      hueDeg: round2(medianHue),
      chromaMin: max(0.01, floor2(medianChroma / 2.0)),
      lMin: min(0.15, max(0.0, floor2(medianL - 0.35))),
      lMax: min(1.0, max(0.95, ceil2(medianL + 0.35)))
    )
  }

  static func rangeWeight(_ range: RangeRefinement, l: Double, chroma: Double, hueDeg: Double)
    -> Double
  {
    guard
      case .color(let targetHue, let halfWidth, let chromaMin, let lMin, let lMax, let feather) =
        range
    else {
      return 1.0
    }
    let c0 = max(chromaMin, 1e-6)
    let chromaWeight = smoothstep(edge0: c0, edge1: 2.0 * c0, x: chroma)
    guard chromaWeight > 0 else { return 0 }
    let delta = abs(signedCircularDeltaDeg(hueDeg, targetHue))
    let hueWeight = bandWeight(
      deltaDeg: delta,
      halfWidthDeg: max(halfWidth, 1e-3),
      feather: min(1.0, max(0.0, feather))
    )
    let lEdge = 0.05
    let lWeight =
      smoothstep(edge0: lMin, edge1: lMin + lEdge, x: l)
      * (1.0 - smoothstep(edge0: lMax - lEdge, edge1: lMax, x: l))
    return chromaWeight * hueWeight * lWeight
  }

  private static func renderSRGBBytes(image: CGImage, width: Int, height: Int) -> [UInt8]? {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    var bytes = [UInt8](repeating: 0, count: width * height * 4)
    let ok = bytes.withUnsafeMutableBytes { ptr -> Bool in
      guard
        let base = ptr.baseAddress,
        let ctx = CGContext(
          data: base,
          width: width,
          height: height,
          bitsPerComponent: 8,
          bytesPerRow: width * 4,
          space: space,
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
      else {
        return false
      }
      ctx.interpolationQuality = .low
      ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
      return true
    }
    return ok ? bytes : nil
  }

  private static func srgbToLinear(_ v: Double) -> Double {
    v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
  }

  private static func linearSRGBToOklab(r: Double, g: Double, b: Double) -> (
    Double, Double, Double
  ) {
    let l = 0.41222147 * r + 0.53633254 * g + 0.05144599 * b
    let m = 0.21190350 * r + 0.68069955 * g + 0.10739696 * b
    let s = 0.08830246 * r + 0.28171884 * g + 0.62997870 * b
    let lCube = cbrt(l)
    let mCube = cbrt(m)
    let sCube = cbrt(s)
    let okL = 0.21045426 * lCube + 0.79361779 * mCube - 0.00407205 * sCube
    let okA = 1.97799850 * lCube - 2.42859221 * mCube + 0.45059371 * sCube
    let okB = 0.02590404 * lCube + 0.78277177 * mCube - 0.80867577 * sCube
    return (okL, okA, okB)
  }

  private static func signedCircularDeltaDeg(_ a: Double, _ b: Double) -> Double {
    let raw = (a - b).truncatingRemainder(dividingBy: 360.0)
    if raw > 180.0 { return raw - 360.0 }
    if raw <= -180.0 { return raw + 360.0 }
    return raw
  }

  private static func wrapHueDeg(_ deg: Double) -> Double {
    signedCircularDeltaDeg(deg, 0.0)
  }

  private static func bandWeight(deltaDeg: Double, halfWidthDeg: Double, feather: Double) -> Double
  {
    if deltaDeg >= halfWidthDeg { return 0.0 }
    let inner = halfWidthDeg * (1.0 - feather)
    if deltaDeg <= inner { return 1.0 }
    let t = (deltaDeg - inner) / (halfWidthDeg - inner)
    return 0.5 * (1.0 + cos(.pi * t))
  }

  private static func smoothstep(edge0: Double, edge1: Double, x: Double) -> Double {
    guard edge1 > edge0 else { return x >= edge0 ? 1.0 : 0.0 }
    let t = min(1.0, max(0.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3.0 - 2.0 * t)
  }

  private static func floor2(_ v: Double) -> Double {
    floor(v * 100.0) / 100.0
  }

  private static func ceil2(_ v: Double) -> Double {
    ceil(v * 100.0) / 100.0
  }

  private static func round2(_ v: Double) -> Double {
    (v * 100.0).rounded() / 100.0
  }
}
