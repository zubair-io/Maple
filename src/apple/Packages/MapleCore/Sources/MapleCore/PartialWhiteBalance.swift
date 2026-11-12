import Foundation

/// Imported axis presence and original coordinates (#3434). Both axes absent is
/// name-only Auto (#4669): As Shot until the shared RAW estimator's pair is
/// resolved off the first frame. Value semantics let undo restore the intent.
/// Serialization uses existing Temperature/Tint/scale fields.
public struct PartialWhiteBalance: Codable, Sendable, Equatable, Hashable {
  public let temperature: Double?
  public let tint: Double?
  public let version: Int
  /// Cold core resolution, carried by undo but never serialized to XMP.
  var resolvedTarget: ResolvedWhiteBalance? = nil

  /// Name-only imported Auto whose estimator pair is not known yet (#4669).
  var isUnresolvedAuto: Bool { temperature == nil && tint == nil && resolvedTarget == nil }

  func resolved(in frame: WbSliderFrame?) -> (temperature: Double, tint: Double) {
    if let resolvedTarget { return (resolvedTarget.temperature, resolvedTarget.tint) }
    guard let frame, frame.isPresent, version != 1 else {
      // Preserve the legacy post-DCP/default behavior when no calibrated frame exists.
      return (temperature ?? 6500, tint ?? 0)
    }
    let pair = WbDngTemperature.authoredPairToV5(
      temperature: temperature ?? Double(frame.sceneCCT),
      tint: tint ?? Double(frame.asShotTint), version: version)
    return (pair.0, pair.1)
  }
}

extension AdjustmentModel {
  /// Fill display values from the decoded frame without authoring the omitted axis.
  func hydratingPartialWhiteBalance(in frame: WbSliderFrame?) -> AdjustmentModel {
    guard let imported = partialWhiteBalance, imported.resolvedTarget == nil, let frame,
      frame.isPresent,
      imported.version != 1
    else { return self }
    let pair = imported.resolved(in: frame)
    var hydrated = self
    hydrated.temperature = pair.temperature
    hydrated.tint = pair.tint
    hydrated.wbScaleVersion = 5
    hydrated.partialWhiteBalance = imported
    return hydrated
  }

  /// Carry a cold core resolution: the live pair is `target`, while the sidecar
  /// keeps the imported intent. Models without unresolved import intent are unchanged.
  func resolvingImportedWhiteBalance(_ target: ResolvedWhiteBalance) -> AdjustmentModel {
    guard var intent = partialWhiteBalance, intent.resolvedTarget == nil else { return self }
    var resolved = self
    resolved.temperature = target.temperature
    resolved.tint = target.tint
    resolved.wbScaleVersion = 5
    intent.resolvedTarget = target
    resolved.partialWhiteBalance = intent
    return resolved
  }

  /// An edit session's render model: name-only Auto takes the session's
  /// resolved pair, As Shot until then (#4669). Every other model is unchanged.
  func overlayingImportedAuto(_ target: ResolvedWhiteBalance?) -> AdjustmentModel {
    guard let target, partialWhiteBalance?.isUnresolvedAuto == true else { return self }
    return resolvingImportedWhiteBalance(target)
  }

  /// Same target for the CPU refine and GPU live paths. Ordinary authored pairs are
  /// already authoritative; partially imported pairs resolve only with a real frame.
  func liveWhiteBalance(in frame: WbSliderFrame?) -> (temperature: Double, tint: Double) {
    partialWhiteBalance?.resolved(in: frame) ?? (temperature, tint)
  }
}

struct ResolvedWhiteBalance: Codable, Sendable, Equatable, Hashable {
  let temperature: Double
  let tint: Double
}
