import Foundation
import RawPipeline

public struct WhiteBalanceSample: Sendable {
  public let temperature: Double
  public let tint: Double
  public let algorithmVersion: UInt32
}

public enum WhiteBalanceSampleError: Error, LocalizedError, Sendable, Equatable {
  case outsideImage, clipped, tooDark, outOfDomain, unsupportedAsset
  case failed

  init(code: Int32) {
    switch code {
    case 11: self = .outsideImage
    case 12: self = .clipped
    case 13: self = .tooDark
    case 14: self = .outOfDomain
    default: self = .failed
    }
  }

  public var errorDescription: String? {
    switch self {
    case .outsideImage:
      return "That point is outside the photo. Pick a neutral area inside the image."
    case .clipped: return "That area is blown out. Pick a darker white or gray surface."
    case .tooDark: return "That area is too dark. Pick a brighter white or gray surface."
    case .outOfDomain:
      return "That color is not a plausible neutral. Pick a different white or gray surface."
    case .unsupportedAsset:
      return "The eyedropper needs a RAW photo. Open the original RAW to sample white balance."
    case .failed:
      return "The RAW could not be sampled. Check that the original is available, then try again."
    }
  }
}

public enum WhiteBalanceSampler {
  /// Cold, explicit analysis. Includes PhotoKit and cloud RAWs by staging
  /// their bytes only for the duration of the call. The current model is
  /// serialized to a private temporary XMP; a pending autosave cannot make
  /// the sampler use stale lens/decode settings. Originals are never written.
  public static func sample(
    asset: AssetRef, model: AdjustmentModel, point: CGPoint
  ) async throws -> WhiteBalanceSample {
    guard asset.isRaw else { throw WhiteBalanceSampleError.unsupportedAsset }
    return try await Task.detached(priority: .userInitiated) {
      let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-wb-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      let scope = asset.scopeParentURL ?? asset.primaryURL
      let accessing = scope?.startAccessingSecurityScopedResource() ?? false
      defer { if accessing { scope?.stopAccessingSecurityScopedResource() } }
      let rawURL: URL
      if let url = asset.primaryURL {
        rawURL = url
      } else if let provider = asset.bytesProvider {
        let bytes = try await provider()
        try Task.checkCancellation()
        rawURL = directory.appendingPathComponent("original")
          .appendingPathExtension(asset.hintExtension ?? "dng")
        try bytes.write(to: rawURL)
      } else {
        throw WhiteBalanceSampleError.unsupportedAsset
      }
      let xmpURL = directory.appendingPathComponent("probe.xmp")
      let xml = XMPSerializer.serialize(model: model, culling: CullingState())
      try xml.write(to: xmpURL, atomically: true, encoding: .utf8)
      try Task.checkCancellation()
      return try sampleSync(rawURL: rawURL, xmpURL: xmpURL, point: point)
    }.value
  }

  nonisolated static func sampleSync(
    rawURL: URL, xmpURL: URL, point: CGPoint
  ) throws -> WhiteBalanceSample {
    var output = MapleWbSample()
    let code = rawURL.path.withCString { raw in
      xmpURL.path.withCString { xmp in
        maple_sample_white_balance_oriented(raw, xmp, Float(point.x), Float(point.y), &output)
      }
    }
    guard code == 0 else { throw WhiteBalanceSampleError(code: code) }
    return WhiteBalanceSample(
      temperature: Double(output.temperature), tint: Double(output.tint),
      algorithmVersion: output.algorithm_version)
  }
}
