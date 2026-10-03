import AMSMB2
import Foundation

extension SMBSource {
  func workflowSidecarPath(for ref: ImageRef, variantId: String) throws -> String {
    let primary = (path(for: ref) as NSString).deletingPathExtension + ".xmp"
    let name = try WorkflowSidecarCore.variantFilename(
      primaryName: (primary as NSString).lastPathComponent, variantId: variantId)
    return ((primary as NSString).deletingLastPathComponent as NSString)
      .appendingPathComponent(name)
  }

  func readWorkflowSidecar(for ref: ImageRef, variantId: String) async throws -> String? {
    guard let client else { throw SMBError.notConnected }
    let path = try workflowSidecarPath(for: ref, variantId: variantId)
    do {
      let data = try await client.contents(atPath: path, range: Range<UInt64>?.none)
      return try Self.checkedWorkflowXML(data, variantId: variantId)
    } catch let error as POSIXError where error.code == .ENOENT {
      guard variantId == WorkflowContract.primaryVariantID else {
        throw WorkflowSidecarError(
          message: "Variant sidecar is missing. Restore it before editing.")
      }
      return nil
    }
  }

  func mutateWorkflowSidecar(
    for ref: ImageRef, variantId: String,
    transform: @Sendable @escaping (String?) throws -> String
  ) async throws -> String {
    guard let client else { throw SMBError.notConnected }
    let path = try workflowSidecarPath(for: ref, variantId: variantId)
    let data = try await client.publishSidecar(atPath: path) { current in
      if current == nil, variantId != WorkflowContract.primaryVariantID {
        throw WorkflowSidecarError(
          message: "Variant sidecar is missing. Restore it before editing.")
      }
      let xml = try current.map { try Self.checkedWorkflowXML($0, variantId: variantId) }
      let output = try transform(xml)
      let bytes = Data(output.utf8)
      _ = try Self.checkedWorkflowXML(bytes, variantId: variantId)
      return bytes
    }
    return try Self.checkedWorkflowXML(data, variantId: variantId)
  }

  func createWorkflowSidecar(
    for ref: ImageRef, record: SidecarWorkflow, sourceVariantId: String
  ) async throws {
    guard let client else { throw SMBError.notConnected }
    try WorkflowSidecarCore.validate(record)
    guard record.variantId != WorkflowContract.primaryVariantID else {
      throw WorkflowSidecarError(message: "Create a new variant identity.")
    }
    guard let current = try await readWorkflowSidecar(for: ref, variantId: sourceVariantId) else {
      throw WorkflowSidecarError(message: "Commit the source before creating a variant.")
    }
    let output = try WorkflowSidecarCore.embed(record, in: current)
    let destination = try workflowSidecarPath(for: ref, variantId: record.variantId)
    _ = try await client.publishSidecar(atPath: destination) { existing in
      guard existing == nil else {
        throw WorkflowSidecarError(message: "That variant identity already exists.")
      }
      return Data(output.utf8)
    }
  }

  func listWorkflowSidecars(for ref: ImageRef) async throws -> [WorkflowVariantSidecar] {
    guard let client else { throw SMBError.notConnected }
    let primary = try workflowSidecarPath(for: ref, variantId: WorkflowContract.primaryVariantID)
    let primaryName = (primary as NSString).lastPathComponent
    let prefix = (primaryName as NSString).deletingPathExtension + ".v"
    let files = try await client.contentsOfDirectory(
      atPath: (primary as NSString).deletingLastPathComponent)
    let ids = try files.compactMap { attributes -> String? in
      guard let name = attributes[.nameKey] as? String,
        name.hasPrefix(prefix), name.hasSuffix(".xmp")
      else { return nil }
      let id = String(name.dropFirst(prefix.count).dropLast(4))
      guard id.count == 36 else { return nil }
      let canonical = try WorkflowSidecarCore.variantFilename(
        primaryName: primaryName, variantId: id)
      guard name == canonical else {
        throw WorkflowSidecarError(message: "Noncanonical variant filename: \(name)")
      }
      return id
    }.sorted()
    var variants: [WorkflowVariantSidecar] = []
    for id in [WorkflowContract.primaryVariantID] + ids {
      let xml = try await readWorkflowSidecar(for: ref, variantId: id)
      variants.append(
        WorkflowVariantSidecar(
          variantId: id,
          filename: try WorkflowSidecarCore.variantFilename(
            primaryName: primaryName, variantId: id),
          workflow: try xml.flatMap { try WorkflowSidecarCore.read(xmp: $0) }, exists: xml != nil))
    }
    return variants
  }

  private static func checkedWorkflowXML(_ data: Data, variantId: String) throws -> String {
    guard let xml = String(data: data, encoding: .utf8) else { throw XMPStoreError.encodingError }
    _ = try XMPParser.parse(xml)
    _ = try WorkflowSidecarCore.variantWorkflow(xmp: xml, variantId: variantId)
    return xml
  }
}
