import Foundation
import RawPipeline
import os

/// Cold import resolution only: no additional FFI call on a slider tick. The
/// original partial XMP remains authoritative for persistence; the numerical
/// live pair comes from the same Rust resolver as full develop, including V1.
/// Name-only Auto (#4669) takes the shared estimator's pair: final outputs
/// await it, an edit session requests it after its As Shot first frame.
/// Cancelling the calling task stops the estimate inside the FFI call (#5922).
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
      let cancel = CancelFlag()
      target = try await withTaskCancellationHandler {
        try await RawProbeStaging.withStagedProbe(
          asset: asset, model: model, stagedRaw: stagedRaw
        ) { raw, sidecar in
          let xml = try String(contentsOf: sidecar, encoding: .utf8)
          return try raw.path.withCString { path in
            try resolve(path: path, xml: xml, cancel: cancel)
          }
        }
      } onCancel: {
        cancel.requestCancel()
      }
    } else {
      let xml = XMPSerializer.serialize(model: model, culling: CullingState())
      target = try await Task.detached(priority: .userInitiated) {
        try resolve(path: nil, xml: xml, cancel: nil)
      }.value
    }
    try Task.checkCancellation()
    return model.resolvingImportedWhiteBalance(target)
  }

  /// `maple_resolve_imported_white_balance_file`'s cancelled return code.
  private static let cancelledReturnCode: Int32 = 4

  /// FFI resolves per RAW path, so tests can count the estimates for a photo.
  /// Unconditional: the release-configuration regression gate reads it too.
  static let ffiCalls = OSAllocatedUnfairLock<[String: Int]>(initialState: [:])

  /// `cancel` stays alive across the call: the FFI reads it until it returns.
  static func resolve(path: UnsafePointer<CChar>?, xml: String, cancel: CancelFlag?) throws
    -> ResolvedWhiteBalance
  {
    if let path { ffiCalls.withLock { $0[String(cString: path), default: 0] += 1 } }
    var pair: (Float, Float) = (0, 0)
    let rc = xml.withCString { text in
      withUnsafeMutablePointer(to: &pair) { pointer in
        pointer.withMemoryRebound(to: Float.self, capacity: 2) {
          maple_resolve_imported_white_balance_file(path, text, cancel?.pointer, $0)
        }
      }
    }
    if rc == cancelledReturnCode { throw CancellationError() }
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
