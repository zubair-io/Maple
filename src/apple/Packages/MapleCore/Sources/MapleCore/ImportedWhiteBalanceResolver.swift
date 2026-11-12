import Foundation
import RawPipeline
import os

/// Cold import resolution only: no additional FFI call on a slider tick. The
/// original partial XMP remains authoritative for persistence; the numerical
/// live pair comes from the same Rust resolver as full develop, including V1.
/// Name-only Auto (#4669) takes the shared estimator's pair: final outputs
/// await it, an edit session requests it after its As Shot first frame.
enum ImportedWhiteBalanceResolver {
  /// `sessionRaw` names the RAW file an edit session decodes. The resolver
  /// then reads that file, so the core decodes it once for both.
  static func resolve(
    asset: AssetRef, model: AdjustmentModel, isRawOverride: Bool? = nil,
    sessionRaw: (@Sendable () async throws -> URL)? = nil
  ) async throws -> AdjustmentModel {
    guard model.partialWhiteBalance.map({ $0.resolvedTarget == nil }) == true else {
      return model
    }
    let target: ResolvedWhiteBalance
    if isRawOverride ?? asset.isRaw {
      let stagedRaw = try await sessionRaw?()
      target = try await RawProbeStaging.withStagedProbe(
        asset: asset, model: model, stagedRaw: stagedRaw
      ) { raw, sidecar in
        let xml = try String(contentsOf: sidecar, encoding: .utf8)
        return try raw.path.withCString { path in try resolve(path: path, xml: xml) }
      }
    } else {
      let xml = XMPSerializer.serialize(model: model, culling: CullingState())
      target = try await Task.detached(priority: .userInitiated) {
        try resolve(path: nil, xml: xml)
      }.value
    }
    try Task.checkCancellation()
    return model.resolvingImportedWhiteBalance(target)
  }

  #if DEBUG
    /// FFI resolves per RAW path, so tests can count the estimates for a photo.
    static let ffiCalls = OSAllocatedUnfairLock<[String: Int]>(initialState: [:])
  #endif

  private static func resolve(path: UnsafePointer<CChar>?, xml: String) throws
    -> ResolvedWhiteBalance
  {
    #if DEBUG
      if let path { ffiCalls.withLock { $0[String(cString: path), default: 0] += 1 } }
    #endif
    var pair: (Float, Float) = (0, 0)
    let rc = xml.withCString { text in
      withUnsafeMutablePointer(to: &pair) { pointer in
        pointer.withMemoryRebound(to: Float.self, capacity: 2) {
          maple_resolve_imported_white_balance_file(path, text, $0)
        }
      }
    }
    guard rc == 0 else {
      let detail = maple_last_error().map { String(cString: $0) } ?? "Unknown RAW error"
      throw NSError(
        domain: "Maple.WhiteBalanceImport", code: Int(rc),
        userInfo: [
          NSLocalizedDescriptionKey: "The imported white balance could not be read: \(detail)"
        ])
    }
    return ResolvedWhiteBalance(temperature: Double(pair.0), tint: Double(pair.1))
  }
}
