// The shared Rust workflow validator/converter; no filesystem I/O (#4036).
import Foundation
import RawPipeline

public struct WorkflowSidecarError: Error, LocalizedError {
  public let message: String
  public var errorDescription: String? { message }
}
public enum WorkflowSidecarCore {
  public static func read(xmp: String) throws -> SidecarWorkflow? {
    let json = try convert(.read, xmp)
    return try JSONDecoder().decode(SidecarWorkflow?.self, from: Data(json.utf8))
  }
  /// Primary editors must never hydrate or overwrite a different branch (#4057).
  /// Legacy sidecars keep their existing parse path without a workflow conversion.
  static func primaryWorkflow(xmp: String) throws -> SidecarWorkflow? {
    try variantWorkflow(xmp: xmp, variantId: WorkflowContract.primaryVariantID)
  }

  /// Editor stores bind an immutable branch identity (#4063); legacy XMP is primary only.
  static func variantWorkflow(xmp: String, variantId: String) throws -> SidecarWorkflow? {
    guard xmp.range(of: WorkflowContract.markupPattern, options: .regularExpression) != nil else {
      guard variantId == WorkflowContract.primaryVariantID else {
        throw WorkflowSidecarError(message: "The named variant has no workflow identity.")
      }
      return nil
    }
    let record = try read(xmp: xmp)
    guard (record?.variantId ?? WorkflowContract.primaryVariantID) == variantId else {
      let label =
        variantId == WorkflowContract.primaryVariantID ? "primary sidecar" : "selected variant"
      throw WorkflowSidecarError(
        message: "Variant identity does not match the \(label). Repair it before editing.")
    }
    return record
  }
  public static func embed(_ workflow: SidecarWorkflow, in xmp: String) throws -> String {
    return try convert(.embed, encode(workflow), xmp)
  }
  public static func validate(_ workflow: SidecarWorkflow) throws {
    _ = try convert(.validate, encode(workflow))
  }
  public static func commit(_ entry: WorkflowHistoryEntry, in xmp: String) throws -> String {
    try convert(.commit, xmp, encode(entry))
  }
  public static func snapshot(_ snapshot: WorkflowSnapshot, in xmp: String) throws -> String {
    try convert(.snapshot, xmp, encode(snapshot))
  }
  public static func restore(_ entry: WorkflowHistoryEntry, in xmp: String) throws -> String {
    try convert(.restore, xmp, encode(entry))
  }
  /// Merge a stale writer onto the file's current document (#4983). `base` is the
  /// last complete sidecar the writer read or published ("" when it saw none).
  public static func reconcile(
    base: String, current: String, incoming: String, nowMs: UInt64
  ) throws -> String {
    try convert(.reconcile, base, current, incoming, nowMs: nowMs)
  }
  /// The undo/redo ids the retained history folds to (#4983).
  public static func cursor(xmp: String) throws -> WorkflowHistoryCursor {
    try JSONDecoder().decode(
      WorkflowHistoryCursor.self, from: Data(convert(.cursor, xmp).utf8))
  }
  /// Whether two sidecars hold the same adjustments, whatever their Workflow records or layout.
  static func holdSameAdjustments(_ first: String?, _ second: String?) throws -> Bool {
    guard let first, let second else { return first == nil && second == nil }
    return try first == second || checkpoint(xmp: first) == checkpoint(xmp: second)
  }
  /// `parentId` for the next entry a writer commits on top of `xmp` ("" with no history).
  static func headId(xmp: String?, variantId: String) throws -> String {
    guard let xmp else { return "" }
    return try variantWorkflow(xmp: xmp, variantId: variantId)?.history.last?.id ?? ""
  }
  private static func encode<T: Encodable>(_ value: T) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    return String(decoding: try encoder.encode(value), as: UTF8.self)
  }
  /// Complete current adjustments without recursively embedding prior history (#4039).
  public static func checkpoint(xmp: String) throws -> String {
    try convert(.checkpoint, xmp)
  }
  public static func variantFilename(primaryName: String, variantId: String) throws -> String {
    try convert(.filename, primaryName, variantId)
  }
  private enum Operation {
    case read, embed, validate, checkpoint, filename, commit, snapshot, restore, reconcile, cursor
  }
  private static func convert(
    _ operation: Operation, _ first: String, _ second: String = "", _ third: String = "",
    nowMs: UInt64 = 0
  ) throws -> String {
    let firstBytes = Array(first.utf8)
    let secondBytes = Array(second.utf8)
    let thirdBytes = Array(third.utf8)
    guard firstBytes.count <= WorkflowContract.maxBytes,
      secondBytes.count <= WorkflowContract.maxBytes,
      thirdBytes.count <= WorkflowContract.maxBytes
    else {
      throw WorkflowSidecarError(message: "Workflow input exceeds byte budget")
    }
    let firstInput = firstBytes.isEmpty ? [UInt8(0)] : firstBytes
    let secondInput = secondBytes.isEmpty ? [UInt8(0)] : secondBytes
    let thirdInput = thirdBytes.isEmpty ? [UInt8(0)] : thirdBytes
    var output = [UInt8](repeating: 0, count: WorkflowContract.maxBytes)
    var length: UInt = 0
    let code = firstInput.withUnsafeBufferPointer { input in
      secondInput.withUnsafeBufferPointer { extra in
        thirdInput.withUnsafeBufferPointer { last in
          output.withUnsafeMutableBufferPointer { out in
            switch operation {
            case .read:
              return maple_workflow_read_xmp(
                input.baseAddress, UInt(firstBytes.count), out.baseAddress, UInt(out.count), &length
              )
            case .validate:
              return maple_workflow_validate_json(
                input.baseAddress, UInt(firstBytes.count), out.baseAddress, UInt(out.count), &length
              )
            case .checkpoint:
              return maple_workflow_checkpoint_xmp(
                input.baseAddress, UInt(firstBytes.count), out.baseAddress, UInt(out.count), &length
              )
            case .embed:
              return maple_workflow_embed_xmp(
                input.baseAddress, UInt(firstBytes.count), extra.baseAddress,
                UInt(secondBytes.count),
                out.baseAddress, UInt(out.count), &length)
            case .commit:
              return maple_workflow_commit_xmp(
                input.baseAddress, UInt(firstBytes.count), extra.baseAddress,
                UInt(secondBytes.count),
                out.baseAddress, UInt(out.count), &length)
            case .snapshot:
              return maple_workflow_snapshot_xmp(
                input.baseAddress, UInt(firstBytes.count), extra.baseAddress,
                UInt(secondBytes.count),
                out.baseAddress, UInt(out.count), &length)
            case .restore:
              return maple_workflow_restore_xmp(
                input.baseAddress, UInt(firstBytes.count), extra.baseAddress,
                UInt(secondBytes.count),
                out.baseAddress, UInt(out.count), &length)
            case .filename:
              return maple_workflow_variant_filename(
                input.baseAddress, UInt(firstBytes.count), extra.baseAddress,
                UInt(secondBytes.count),
                out.baseAddress, UInt(out.count), &length)
            case .reconcile:
              return maple_workflow_reconcile_xmp(
                input.baseAddress, UInt(firstBytes.count), extra.baseAddress,
                UInt(secondBytes.count),
                last.baseAddress, UInt(thirdBytes.count), nowMs, out.baseAddress, UInt(out.count),
                &length)
            case .cursor:
              return maple_workflow_cursor_xmp(
                input.baseAddress, UInt(firstBytes.count), out.baseAddress, UInt(out.count), &length
              )
            }
          }
        }
      }
    }
    guard code == 0, length <= UInt(output.count) else {
      let message =
        maple_last_error().map { String(cString: $0) } ?? "Workflow conversion failed (\(code))"
      throw WorkflowSidecarError(message: message)
    }
    return String(decoding: output.prefix(Int(length)), as: UTF8.self)
  }
}

/// The ids `cursor` folds the retained history into (#4983).
public struct WorkflowHistoryCursor: Decodable, Equatable, Sendable {
  public let undo: [String]
  public let redo: [String]
  public let synced: Bool
}

extension WorkflowContract {
  /// `writer` label of every history entry this host records.
  static let appleWriter = "apple"
}

extension WorkflowHistoryEntry {
  /// Same action under the same identity, whatever merge rewrote its lineage or state.
  func isSameAction(as other: WorkflowHistoryEntry) -> Bool {
    id == other.id && createdAtMs == other.createdAtMs && action == other.action
      && label == other.label
  }

  /// The entry recording `checkpoint` as its state; `nil` keeps its own.
  func holding(_ checkpoint: String?) -> WorkflowHistoryEntry {
    WorkflowHistoryEntry(
      id: id, createdAtMs: createdAtMs, action: action, label: label, parentId: parentId,
      writer: writer, adjustmentXmp: checkpoint ?? adjustmentXmp)
  }
}
