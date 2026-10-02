// Independent portable sidecars; no original-file writes (#4040 / #2437).
import Foundation

public struct WorkflowVariantSidecar: Sendable {
  public let variantId: String
  public let filename: String
  public let workflow: SidecarWorkflow?
  public let exists: Bool
}

/// Sibling storage is reconstructed from XMP. UI/cache switching follows in #2437.
public actor WorkflowVariantStore {
  private let rawURL: URL
  public init(rawURL: URL) { self.rawURL = rawURL }

  public func list() throws -> [WorkflowVariantSidecar] {
    let primary = SidecarPath.sidecarURL(for: rawURL)
    let prefix = primary.deletingPathExtension().lastPathComponent + ".v"
    let files = try FileManager.default.contentsOfDirectory(
      at: primary.deletingLastPathComponent(), includingPropertiesForKeys: nil
    )
    .sorted { $0.lastPathComponent < $1.lastPathComponent }
    let siblings = try files.compactMap { file -> WorkflowVariantSidecar? in
      let name = file.lastPathComponent
      guard name.hasPrefix(prefix), name.hasSuffix(".xmp") else { return nil }
      let id = String(name.dropFirst(prefix.count).dropLast(4))
      guard id.count == 36 else { return nil }  // Other tools' .v2 files are not UUID variants.
      let expected = try SidecarPath.variantURL(for: rawURL, variantId: id)
      guard expected.lastPathComponent == name else {
        throw failure("Noncanonical variant filename: \(name)")
      }
      return try inspect(id)
    }
    return [try inspect(WorkflowContract.primaryVariantID)] + siblings
  }

  /// A missing primary is explicit absence; a missing named variant is an error.
  public func read(variantId: String) throws -> String? {
    let url = try SidecarPath.variantURL(for: rawURL, variantId: variantId)
    let xml = try readOptional(url)
    if xml == nil, variantId != WorkflowContract.primaryVariantID {
      throw failure(
        "Variant sidecar is missing: \(url.lastPathComponent). Restore it before editing.")
    }
    if let xml {
      try requireIdentity(WorkflowSidecarCore.read(xmp: xml), variantId, url.lastPathComponent)
    }
    return xml
  }

  /// The caller first commits the source's current adjustments. Publication is
  /// create-only at the kernel: another actor cannot overwrite an existing UUID.
  public func create(
    _ workflow: SidecarWorkflow, sourceVariantId: String = WorkflowContract.primaryVariantID
  ) throws -> URL {
    guard workflow.variantId != WorkflowContract.primaryVariantID else {
      throw failure("Create a new variant identity; the primary already exists.")
    }
    try WorkflowSidecarCore.validate(workflow)
    let destination = try SidecarPath.variantURL(for: rawURL, variantId: workflow.variantId)
    guard let source = try read(variantId: sourceVariantId) else {
      throw failure("Commit the source adjustments before creating a variant.")
    }
    let output = try WorkflowSidecarCore.embed(workflow, in: source)
    let temporary = destination.deletingLastPathComponent().appendingPathComponent(
      ".variant.tmp.\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: temporary) }
    try Data(output.utf8).write(to: temporary, options: .atomic)
    try FileManager.default.linkItem(at: temporary, to: destination)
    return destination
  }

  /// Preserve authoring records through ordinary model writes. Validation and
  /// identity checks precede the same atomic publication used by primary XMP.
  public func write(variantId: String, xmp: String) throws {
    let destination = try SidecarPath.variantURL(for: rawURL, variantId: variantId)
    let existing = try read(variantId: variantId)
    let oldRecord = try existing.map { try WorkflowSidecarCore.read(xmp: $0) } ?? nil
    let nextRecord = try WorkflowSidecarCore.read(xmp: xmp)
    let output: String
    if let nextRecord {
      try requireIdentity(nextRecord, variantId, destination.lastPathComponent)
      output = xmp
    } else if let oldRecord {
      output = try WorkflowSidecarCore.embed(oldRecord, in: xmp)
    } else {
      try requireIdentity(nil, variantId, destination.lastPathComponent)
      output = xmp
    }
    try Data(output.utf8).write(to: destination, options: .atomic)
  }

  private func inspect(_ id: String) throws -> WorkflowVariantSidecar {
    let url = try SidecarPath.variantURL(for: rawURL, variantId: id)
    let xml = try read(variantId: id)
    return WorkflowVariantSidecar(
      variantId: id, filename: url.lastPathComponent,
      workflow: try xml.map { try WorkflowSidecarCore.read(xmp: $0) } ?? nil, exists: xml != nil)
  }
  private func readOptional(_ url: URL) throws -> String? {
    do { return try String(contentsOf: url, encoding: .utf8) } catch let error as CocoaError
      where error.code == .fileReadNoSuchFile
    { return nil }
  }
  private func requireIdentity(_ record: SidecarWorkflow?, _ id: String, _ filename: String) throws
  {
    guard (record?.variantId ?? WorkflowContract.primaryVariantID) == id else {
      throw failure(
        "Variant identity does not match \(filename). Repair the sidecar before editing.")
    }
  }
  private func failure(_ message: String) -> WorkflowSidecarError {
    WorkflowSidecarError(message: message)
  }
}
