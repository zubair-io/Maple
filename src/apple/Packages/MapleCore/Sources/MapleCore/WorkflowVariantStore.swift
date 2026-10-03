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
  private let primarySidecarURL: URL
  public init(rawURL: URL) { self.primarySidecarURL = SidecarPath.sidecarURL(for: rawURL) }

  /// Photos keeps the same sibling contract beneath its canonical App Support file (#4063).
  public init(primarySidecarURL: URL) { self.primarySidecarURL = primarySidecarURL }

  public func list() throws -> [WorkflowVariantSidecar] {
    let primary = primarySidecarURL
    let prefix = primary.deletingPathExtension().lastPathComponent + ".v"
    let files: [URL]
    do {
      files = try FileManager.default.contentsOfDirectory(
        at: primary.deletingLastPathComponent(), includingPropertiesForKeys: nil)
    } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
      return [try inspect(WorkflowContract.primaryVariantID)]
    }
    let sorted =
      files
      .sorted { $0.lastPathComponent < $1.lastPathComponent }
    let siblings = try sorted.compactMap { file -> WorkflowVariantSidecar? in
      let name = file.lastPathComponent
      guard name.hasPrefix(prefix), name.hasSuffix(".xmp") else { return nil }
      let id = String(name.dropFirst(prefix.count).dropLast(4))
      guard id.count == 36 else { return nil }  // Other tools' .v2 files are not UUID variants.
      let expected = try variantURL(id)
      guard expected.lastPathComponent == name else {
        throw failure("Noncanonical variant filename: \(name)")
      }
      return try inspect(id)
    }
    return [try inspect(WorkflowContract.primaryVariantID)] + siblings
  }

  /// A missing primary is explicit absence; a missing named variant is an error.
  public func read(variantId: String) throws -> String? {
    try read(variantId: variantId, at: variantURL(variantId))
  }

  private func read(variantId: String, at url: URL) throws -> String? {
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
    let destination = try variantURL(workflow.variantId)
    guard let source = try read(variantId: sourceVariantId) else {
      throw failure("Commit the source adjustments before creating a variant.")
    }
    let output = try WorkflowSidecarCore.embed(workflow, in: source)
    try createSidecar(output, at: destination)
    return destination
  }

  /// Preserve authoring records through ordinary model writes. Validation and
  /// identity checks precede the same atomic publication used by primary XMP.
  public func write(variantId: String, xmp: String) throws {
    _ = try coordinateWrite(variantId: variantId) { existing in
      let oldRecord = try existing.map { try WorkflowSidecarCore.read(xmp: $0) } ?? nil
      let nextRecord = try WorkflowSidecarCore.read(xmp: xmp)
      return try nextRecord == nil && oldRecord != nil
        ? WorkflowSidecarCore.embed(oldRecord!, in: xmp) : xmp
    }
  }

  /// Confirm exactly the branch the editor read before publishing a semantic action (#4045).
  public func commit(
    variantId: String, expectedXmp: String?, xmp: String, entry: WorkflowHistoryEntry
  ) throws -> String {
    try mutate(variantId: variantId, expectedXmp: expectedXmp) { current in
      let checkpoint = try WorkflowSidecarCore.checkpoint(xmp: xmp)
      let record = try current.map { try WorkflowSidecarCore.read(xmp: $0) } ?? nil
      let candidate =
        try record.map { try WorkflowSidecarCore.embed($0, in: checkpoint) } ?? checkpoint
      return try WorkflowSidecarCore.commit(entry, in: candidate)
    }
  }

  public func saveSnapshot(
    variantId: String, expectedXmp: String, snapshot: WorkflowSnapshot
  ) throws -> String {
    try mutate(variantId: variantId, expectedXmp: expectedXmp) { current in
      guard let current else {
        throw self.failure("Commit the source adjustments before creating a snapshot.")
      }
      return try WorkflowSidecarCore.snapshot(snapshot, in: current)
    }
  }

  public func restore(
    variantId: String, expectedXmp: String, entry: WorkflowHistoryEntry
  ) throws -> String {
    try mutate(variantId: variantId, expectedXmp: expectedXmp) { current in
      guard let current else {
        throw self.failure("The sidecar is missing. Restore it before editing.")
      }
      return try WorkflowSidecarCore.restore(entry, in: current)
    }
  }

  private func mutate(
    variantId: String, expectedXmp: String?, convert: (String?) throws -> String
  ) throws -> String {
    try coordinateWrite(variantId: variantId) { current in
      guard current == expectedXmp else {
        throw self.failure("Variant changed. Reopen it before saving this action.")
      }
      return try convert(current)
    }
  }

  /// Separate actor instances coordinate read/convert/publication as one file
  /// operation. Uncooperative external applications retain the existing atomic
  /// file-write contract; they do not provide a filesystem compare-and-swap.
  private func coordinateWrite(
    variantId: String, convert: (String?) throws -> String
  ) throws -> String {
    let destination = try variantURL(variantId)
    let coordinator = NSFileCoordinator(filePresenter: nil)
    var error: NSError?
    var result: Result<String, Error>?
    coordinator.coordinate(writingItemAt: destination, options: [], error: &error) { url in
      result = Result {
        let current = try self.read(variantId: variantId, at: url)
        let output = try convert(current)
        try self.requireIdentity(
          WorkflowSidecarCore.read(xmp: output), variantId, url.lastPathComponent)
        if current == nil {
          try self.createSidecar(output, at: url)
        } else {
          try Data(output.utf8).write(to: url, options: .atomic)
        }
        return output
      }
    }
    if let error { throw error }
    guard let result else {
      throw failure("Unable to coordinate the sidecar save. Retry after reopening.")
    }
    return try result.get()
  }

  private func createSidecar(_ output: String, at destination: URL) throws {
    let temporary = destination.deletingLastPathComponent().appendingPathComponent(
      ".variant.tmp.\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: temporary) }
    try Data(output.utf8).write(to: temporary, options: .atomic)
    try FileManager.default.linkItem(at: temporary, to: destination)
  }

  private func inspect(_ id: String) throws -> WorkflowVariantSidecar {
    let url = try variantURL(id)
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
  private func variantURL(_ id: String) throws -> URL {
    let filename = try WorkflowSidecarCore.variantFilename(
      primaryName: primarySidecarURL.lastPathComponent, variantId: id)
    return primarySidecarURL.deletingLastPathComponent().appendingPathComponent(filename)
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
