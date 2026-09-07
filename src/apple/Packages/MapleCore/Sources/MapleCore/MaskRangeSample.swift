// MaskRangeSample.swift — the colour-range eyedropper's FFI boundary (#362):
// the seeded `papp:Range*` quadruple raw-core reads off the pixel entering
// the local-adjustments stage, and the reasons a click could not become
// one. Same transport as `WhiteBalanceSampler` (#2434), sharing its RAW +
// XMP staging.

import Foundation
import RawPipeline

/// The four range coordinates a pick seeds. The layer's band width and
/// feather are the user's and are never part of a sample.
public struct MaskRangeSample: Sendable, Equatable {
  public let hueDeg: Double
  public let chromaMin: Double
  public let lMin: Double
  public let lMax: Double

  public init(hueDeg: Double, chromaMin: Double, lMin: Double, lMax: Double) {
    self.hueDeg = hueDeg
    self.chromaMin = chromaMin
    self.lMin = lMin
    self.lMax = lMax
  }
}

public enum MaskRangeSampleError: Error, LocalizedError, Sendable, Equatable {
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
    case .neutral: return "That area is neutral. Pick a coloured area to select its range."
    case .tooDark: return "That area is too dark. Pick a brighter coloured area."
    case .unsupportedAsset:
      return "The eyedropper needs a RAW photo. Open the original RAW to sample a colour range."
    case .failed:
      return "The RAW could not be sampled. Check that the original is available, then try again."
    }
  }
}

public enum MaskRangeSampler {
  /// Cold, explicit analysis under the CURRENT model — the range must track
  /// the exposure and white balance the photographer is looking at. Stages
  /// the RAW and a private XMP exactly as the white-balance sampler does.
  public static func sample(
    asset: AssetRef, model: AdjustmentModel, point: CGPoint
  ) async throws -> MaskRangeSample {
    guard asset.isRaw else { throw MaskRangeSampleError.unsupportedAsset }
    return try await RawProbeStaging.withStagedProbe(asset: asset, model: model) { rawURL, xmpURL in
      try sampleSync(rawURL: rawURL, xmpURL: xmpURL, point: point)
    }
  }

  nonisolated static func sampleSync(
    rawURL: URL, xmpURL: URL, point: CGPoint
  ) throws -> MaskRangeSample {
    var output = MapleRangeSeed()
    let code = rawURL.path.withCString { raw in
      xmpURL.path.withCString { xmp in
        maple_sample_mask_range_oriented(raw, xmp, Float(point.x), Float(point.y), &output)
      }
    }
    guard code == 0 else { throw MaskRangeSampleError(code: code) }
    return MaskRangeSample(
      hueDeg: Double(output.hue_deg), chromaMin: Double(output.chroma_min),
      lMin: Double(output.l_min), lMax: Double(output.l_max))
  }
}
