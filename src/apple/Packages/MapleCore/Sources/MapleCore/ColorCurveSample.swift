// ColorCurveSample.swift — the Oklab secondary color curve eyedropper's FFI
// boundary (#5041): reads normalized `(uH, uC, uL)` and Oklab `(l, c, hueDeg)`
// off the pixel entering Stage 22b (`stages::color_curves`, i.e. after WB,
// Exposure, Tone Curve, Vibrance, Saturation, and 8-band HSL, before AgX).

import Foundation
import RawPipeline

public struct ColorCurveSample: Sendable, Equatable {
  public let uH: Double
  public let uC: Double
  public let uL: Double
  public let l: Double
  public let c: Double
  public let hueDeg: Double

  public init(uH: Double, uC: Double, uL: Double, l: Double, c: Double, hueDeg: Double) {
    self.uH = uH
    self.uC = uC
    self.uL = uL
    self.l = l
    self.c = c
    self.hueDeg = hueDeg
  }
}

public enum ColorCurveSampleError: Error, LocalizedError, Sendable, Equatable {
  case outsideImage, neutral, tooDark, unsupportedAsset
  case failed

  init(code: Int32) {
    switch code {
    case 11: self = .outsideImage
    case 13: self = .tooDark
    case 15: self = .neutral
    default: self = .failed
    }
  }

  public var errorDescription: String? {
    switch self {
    case .outsideImage:
      return "That point is outside the photo. Pick a colour inside the image."
    case .neutral: return "That area is neutral. Pick a coloured area to place a curve anchor."
    case .tooDark: return "That area is too dark. Pick a brighter area."
    case .unsupportedAsset:
      return "The eyedropper needs a RAW photo. Open the original RAW to sample a colour curve."
    case .failed:
      return "The RAW could not be sampled. Check that the original is available, then try again."
    }
  }
}

public enum ColorCurveSampler {
  public static func sample(
    asset: AssetRef, model: AdjustmentModel, point: CGPoint
  ) async throws -> ColorCurveSample {
    guard asset.isRaw else { throw ColorCurveSampleError.unsupportedAsset }
    return try await RawProbeStaging.withStagedProbe(asset: asset, model: model) { rawURL, xmpURL in
      try sampleSync(rawURL: rawURL, xmpURL: xmpURL, point: point)
    }
  }

  nonisolated static func sampleSync(
    rawURL: URL, xmpURL: URL, point: CGPoint
  ) throws -> ColorCurveSample {
    var output = MapleColorCurveSample()
    let code = rawURL.path.withCString { raw in
      xmpURL.path.withCString { xmp in
        maple_sample_color_curve_oriented(raw, xmp, Float(point.x), Float(point.y), &output)
      }
    }
    guard code == 0 else { throw ColorCurveSampleError(code: code) }
    return ColorCurveSample(
      uH: Double(output.u_h), uC: Double(output.u_c), uL: Double(output.u_l),
      l: Double(output.l), c: Double(output.c), hueDeg: Double(output.hue_deg))
  }
}
