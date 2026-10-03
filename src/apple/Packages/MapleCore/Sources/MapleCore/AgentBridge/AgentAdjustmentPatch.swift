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
}
