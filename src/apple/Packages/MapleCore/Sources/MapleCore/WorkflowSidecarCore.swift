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
    guard xmp.range(of: WorkflowContract.markupPattern, options: .regularExpression) != nil else {
      return nil
    }
    let record = try read(xmp: xmp)
    guard
      (record?.variantId ?? WorkflowContract.primaryVariantID) == WorkflowContract.primaryVariantID
    else {
      throw WorkflowSidecarError(
        message: "Variant identity does not match the primary sidecar. Repair it before editing.")
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
    case read, embed, validate, checkpoint, filename, commit, snapshot, restore
  }
  private static func convert(_ operation: Operation, _ first: String, _ second: String = "") throws
    -> String
  {
    let firstBytes = Array(first.utf8)
    let secondBytes = Array(second.utf8)
    guard firstBytes.count <= WorkflowContract.maxBytes,
      secondBytes.count <= WorkflowContract.maxBytes
    else {
      throw WorkflowSidecarError(message: "Workflow input exceeds byte budget")
    }
    let firstInput = firstBytes.isEmpty ? [UInt8(0)] : firstBytes
    let secondInput = secondBytes.isEmpty ? [UInt8(0)] : secondBytes
    var output = [UInt8](repeating: 0, count: WorkflowContract.maxBytes)
    var length: UInt = 0
    let code = firstInput.withUnsafeBufferPointer { input in
      secondInput.withUnsafeBufferPointer { extra in
        output.withUnsafeMutableBufferPointer { out in
          switch operation {
          case .read:
            return maple_workflow_read_xmp(
              input.baseAddress, UInt(firstBytes.count), out.baseAddress, UInt(out.count), &length)
          case .validate:
            return maple_workflow_validate_json(
              input.baseAddress, UInt(firstBytes.count), out.baseAddress, UInt(out.count), &length)
          case .checkpoint:
            return maple_workflow_checkpoint_xmp(
              input.baseAddress, UInt(firstBytes.count), out.baseAddress, UInt(out.count), &length)
          case .embed:
            return maple_workflow_embed_xmp(
              input.baseAddress, UInt(firstBytes.count), extra.baseAddress, UInt(secondBytes.count),
              out.baseAddress, UInt(out.count), &length)
          case .commit:
            return maple_workflow_commit_xmp(
              input.baseAddress, UInt(firstBytes.count), extra.baseAddress, UInt(secondBytes.count),
              out.baseAddress, UInt(out.count), &length)
          case .snapshot:
            return maple_workflow_snapshot_xmp(
              input.baseAddress, UInt(firstBytes.count), extra.baseAddress, UInt(secondBytes.count),
              out.baseAddress, UInt(out.count), &length)
          case .restore:
            return maple_workflow_restore_xmp(
              input.baseAddress, UInt(firstBytes.count), extra.baseAddress, UInt(secondBytes.count),
              out.baseAddress, UInt(out.count), &length)
          case .filename:
            return maple_workflow_variant_filename(
              input.baseAddress, UInt(firstBytes.count), extra.baseAddress, UInt(secondBytes.count),
              out.baseAddress, UInt(out.count), &length)
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
