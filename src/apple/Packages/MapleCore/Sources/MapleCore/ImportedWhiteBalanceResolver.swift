import Foundation
import RawPipeline

/// Cold import resolution only: no additional FFI call on a slider tick. The
/// original partial XMP remains authoritative for persistence; the numerical
/// live pair comes from the same Rust resolver as full develop, including V1.
enum ImportedWhiteBalanceResolver {
  static func resolve(asset: AssetRef, model: AdjustmentModel) async throws -> AdjustmentModel {
    guard let imported = model.partialWhiteBalance, imported.resolvedTarget == nil else {
      return model
    }
    let target: ResolvedWhiteBalance
    if asset.isRaw {
      target = try await RawProbeStaging.withStagedProbe(asset: asset, model: model) {
        raw, sidecar in
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
    var resolved = model
    resolved.temperature = target.temperature
    resolved.tint = target.tint
    resolved.wbScaleVersion = 5
    var intent = imported
    intent.resolvedTarget = target
    resolved.temperatureSeen = model.temperatureSeen
    resolved.tintSeen = model.tintSeen
    resolved.partialWhiteBalance = intent
    return resolved
  }

  private static func resolve(path: UnsafePointer<CChar>?, xml: String) throws
    -> ResolvedWhiteBalance
  {
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
