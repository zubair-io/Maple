import Foundation

/// The camera's current-scale pair, rounded in the same way as editor seeding.
public struct WhiteBalanceTransferBaseline: Codable, Sendable, Equatable {
  public let temperature: Double
  public let tint: Double

  public init(temperature: Double, tint: Double) {
    self.temperature = temperature
    self.tint = tint
  }

  var isValid: Bool { temperature.isFinite && temperature > 0 && tint.isFinite }
}

/// A target-specific absolute patch. Persist before writing; replay merges only
/// its chosen groups so another edit to an unselected group is never rolled back.
public struct PreparedAdjustmentTransfer: Codable, Sendable, Equatable {
  public let model: AdjustmentModel
  public let groupIDs: [String]
  public let before: AdjustmentModel?

  public init(model: AdjustmentModel, groupIDs: [String], before: AdjustmentModel? = nil) {
    self.model = model
    self.groupIDs = groupIDs
    self.before = before
  }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    model = try values.decode(AdjustmentModel.self, forKey: .model)
    groupIDs = try values.decode([String].self, forKey: .groupIDs)
    before = try values.decodeIfPresent(AdjustmentModel.self, forKey: .before)
    guard !groupIDs.isEmpty, groups.count == groupIDs.count else {
      throw BatchAdjustmentError.invalidOperation
    }
  }

  public var groups: Set<AdjustmentGroup> {
    Set(groupIDs.compactMap(AdjustmentGroup.init(rawValue:)))
  }

  /// Prepared replay may accept its original state or the already-written
  /// result. A later edit to a selected group is a conflict, never an overwrite.
  public func validate(current: AdjustmentModel) throws {
    guard let before else { return }
    let selected: (AdjustmentModel) -> AdjustmentModel = {
      var value = AdjustmentGroupMerge.merged(.default, applying: $0, groups: groups)
      // As Shot numeric values are camera placeholders, deliberately omitted
      // by canonical XMP. Compare the authored mode rather than those seeds.
      if value.wbSource == .asShot {
        value.temperature = AdjustmentModel.default.temperature
        value.tint = AdjustmentModel.default.tint
      }
      return value
    }
    guard selected(current) == selected(before) || selected(current) == selected(model) else {
      throw AdjustmentTransferError.targetChanged
    }
  }

  public func applying(to target: AdjustmentModel) -> AdjustmentModel {
    AdjustmentGroupMerge.merged(target, applying: model, groups: groups)
  }
}

public enum AdjustmentTransferError: Error, LocalizedError {
  case legacyWhiteBalance, missingBaseline, invalidWhiteBalance, targetChanged

  public var errorDescription: String? {
    switch self {
    case .targetChanged:
      return
        "This photo’s selected settings changed after the transfer was prepared. Copy and review a new transfer to keep those edits."
    case .legacyWhiteBalance:
      return
        "Relative white balance requires a current-scale source. Reapply its white balance first."
    case .missingBaseline:
      return
        "Cannot read camera as-shot white balance. Use absolute white balance or retry this photo."
    case .invalidWhiteBalance:
      return "The source white balance is not finite. Correct it before copying these settings."
    }
  }
}

public enum AdjustmentTransfer {
  public static func prepare(
    source: AdjustmentModel,
    groups: Set<AdjustmentGroup>,
    relativeWhiteBalance: Bool,
    sourceBaseline: WhiteBalanceTransferBaseline? = nil,
    targetBaseline: WhiteBalanceTransferBaseline? = nil
  ) throws -> PreparedAdjustmentTransfer {
    var patch = source
    if relativeWhiteBalance && groups.contains(.whiteBalance) {
      guard source.wbScaleVersion == AdjustmentModel.default.wbScaleVersion else {
        throw AdjustmentTransferError.legacyWhiteBalance
      }
      guard let sourceBaseline, sourceBaseline.isValid,
        let targetBaseline, targetBaseline.isValid
      else { throw AdjustmentTransferError.missingBaseline }
      let temperatureDelta =
        source.wbSource == .asShot ? 0 : source.temperature - sourceBaseline.temperature
      let tintDelta = source.wbSource == .asShot ? 0 : source.tint - sourceBaseline.tint
      guard temperatureDelta.isFinite && tintDelta.isFinite else {
        throw AdjustmentTransferError.invalidWhiteBalance
      }
      if adjustmentTransferModes["temperature"] == .relative {
        let range = AdjustmentModel.temperatureRange
        patch.temperature = min(
          range.upperBound, max(range.lowerBound, targetBaseline.temperature + temperatureDelta))
      }
      if adjustmentTransferModes["tint"] == .relative {
        let range = AdjustmentModel.tintRange
        patch.tint = min(range.upperBound, max(range.lowerBound, targetBaseline.tint + tintDelta))
      }
      patch.wbScaleVersion = AdjustmentModel.default.wbScaleVersion
      patch.wbSource = .manual
    }
    if groups.contains(.whiteBalance) {
      patch.wbSampleX = 0
      patch.wbSampleY = 0
      patch.wbAlgorithmVersion = 0
    }
    return PreparedAdjustmentTransfer(model: patch, groupIDs: groups.map(\.rawValue).sorted())
  }
}
