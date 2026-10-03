import Foundation
import MapleAgentWire

/// Validates an agent's slider patch against Maple's generated schema and
/// merges it into a model. Out-of-range values are rejected rather than
/// clamped so the agent never believes a value landed that did not.
enum AgentAdjustmentPatch {
  /// Every numeric slider an agent may set, keyed by canonical snake_case
  /// name. Only fields with both a model key path and a generated range.
  static let adjustableFields: [String: AdjustmentModel.FieldName] = {
    var fields: [String: AdjustmentModel.FieldName] = [:]
    for field in AdjustmentModel.FieldName.allCases
    where field.numericKeyPath != nil && field.numericRange != nil {
      fields[field.rawValue] = field
    }
    return fields
  }()

  static func describe(_ model: AdjustmentModel) -> JSONValue {
    var fields: [String: JSONValue] = [:]
    for (name, field) in adjustableFields {
      guard let keyPath = field.numericKeyPath, let range = field.numericRange else { continue }
      fields[name] = [
        "value": .number(model[keyPath: keyPath]),
        "min": .number(range.lowerBound),
        "max": .number(range.upperBound),
      ]
    }
    return .object(fields)
  }

  /// The merged model and, for each field whose value changed, its new
  /// value. Throws `invalid_arguments` listing every problem at once.
  static func apply(_ patch: [String: JSONValue], to model: AdjustmentModel) throws -> (
    model: AdjustmentModel, applied: [String: Double]
  ) {
    guard !patch.isEmpty else {
      throw AgentError(
        code: "invalid_arguments", message: "`adjustments` must name at least one slider.")
    }
    var problems: [String] = []
    var fields: [String: PresetFieldValue] = [:]
    for (name, value) in patch.sorted(by: { $0.key < $1.key }) {
      guard let field = adjustableFields[name], let range = field.numericRange else {
        problems.append("`\(name)` is not an adjustable slider")
        continue
      }
      guard let number = value.numberValue, number.isFinite else {
        problems.append("`\(name)` must be a finite number")
        continue
      }
      guard range.contains(number) else {
        problems.append(
          "`\(name)` = \(number) is outside \(range.lowerBound)…\(range.upperBound)")
        continue
      }
      fields[name] = .number(number)
    }
    guard problems.isEmpty else {
      throw AgentError(
        code: "invalid_arguments",
        message: problems.joined(separator: "; ")
          + ". Nothing was applied. Call maple_get_active_photo for valid names and ranges.")
    }
    let merged = PresetAdjustments.merged(model, applying: fields).model
    var applied: [String: Double] = [:]
    for name in fields.keys {
      guard let keyPath = adjustableFields[name]?.numericKeyPath else { continue }
      if merged[keyPath: keyPath] != model[keyPath: keyPath] {
        applied[name] = merged[keyPath: keyPath]
      }
    }
    return (merged, applied)
  }

  /// Local adjustment fields that can be applied to a mask layer.
  static let localAdjustableRanges: [String: ClosedRange<Double>] = [
    "exposure": -5.0...5.0,
    "contrast": -100.0...100.0,
    "highlights": -100.0...100.0,
    "shadows": -100.0...100.0,
    "whites": -100.0...100.0,
    "blacks": -100.0...100.0,
    "saturation": -100.0...100.0,
    "vibrance": -100.0...100.0,
    "temperature": -100.0...100.0,
    "tint": -100.0...100.0,
    "hue": -100.0...100.0,
    "texture": -100.0...100.0,
    "clarity": -100.0...100.0,
    "dehaze": -100.0...100.0,
    "sharpness": -100.0...100.0,
    "luminance_noise": 0.0...100.0,
    "defringe": 0.0...100.0,
  ]

  /// Validates and applies a slider patch to a mask layer's `PartialAdjustments`.
  static func applyLocal(
    _ patch: [String: JSONValue],
    to current: PartialAdjustments
  ) throws -> (adjustments: PartialAdjustments, applied: [String: Double]) {
    guard !patch.isEmpty else {
      throw AgentError(
        code: "invalid_arguments",
        message: "`adjustments` must name at least one slider."
      )
    }
    var problems: [String] = []
    var validValues: [String: Double] = [:]

    for (name, value) in patch.sorted(by: { $0.key < $1.key }) {
      guard let range = localAdjustableRanges[name] else {
        problems.append("`\(name)` is not an adjustable local slider")
        continue
      }
      guard let number = value.numberValue, number.isFinite else {
        problems.append("`\(name)` must be a finite number")
        continue
      }
      guard range.contains(number) else {
        problems.append("`\(name)` = \(number) is outside \(range.lowerBound)…\(range.upperBound)")
        continue
      }
      validValues[name] = number
    }

    guard problems.isEmpty else {
      throw AgentError(
        code: "invalid_arguments",
        message: problems.joined(separator: "; ")
          + ". Nothing was applied. Call maple_get_active_photo for valid mask sliders."
      )
    }

    var updated = current
    var applied: [String: Double] = [:]

    for (name, val) in validValues {
      applied[name] = val
      switch name {
      case "exposure": updated.exposure = val
      case "contrast": updated.contrast = val
      case "highlights": updated.highlights = val
      case "shadows": updated.shadows = val
      case "whites": updated.whites = val
      case "blacks": updated.blacks = val
      case "saturation": updated.saturation = val
      case "vibrance": updated.vibrance = val
      case "temperature": updated.temperature = val
      case "tint": updated.tint = val
      case "hue": updated.hue = val
      case "texture": updated.texture = val
      case "clarity": updated.clarity = val
      case "dehaze": updated.dehaze = val
      case "sharpness": updated.sharpness = val
      case "luminance_noise": updated.luminanceNoise = val
      case "defringe": updated.defringe = val
      default: break
      }
    }

    return (updated, applied)
  }

  static func describeLocal(_ adjustments: PartialAdjustments) -> JSONValue {
    var fields: [String: JSONValue] = [:]
    for (name, range) in localAdjustableRanges {
      let val: Double?
      switch name {
      case "exposure": val = adjustments.exposure
      case "contrast": val = adjustments.contrast
      case "highlights": val = adjustments.highlights
      case "shadows": val = adjustments.shadows
      case "whites": val = adjustments.whites
      case "blacks": val = adjustments.blacks
      case "saturation": val = adjustments.saturation
      case "vibrance": val = adjustments.vibrance
      case "temperature": val = adjustments.temperature
      case "tint": val = adjustments.tint
      case "hue": val = adjustments.hue
      case "texture": val = adjustments.texture
      case "clarity": val = adjustments.clarity
      case "dehaze": val = adjustments.dehaze
      case "sharpness": val = adjustments.sharpness
      case "luminance_noise": val = adjustments.luminanceNoise
      case "defringe": val = adjustments.defringe
      default: val = nil
      }
      var fieldObj: [String: JSONValue] = [
        "min": .number(range.lowerBound),
        "max": .number(range.upperBound),
      ]
      if let val {
        fieldObj["value"] = .number(val)
      }
      fields[name] = .object(fieldObj)
    }
    return .object(fields)
  }
}
