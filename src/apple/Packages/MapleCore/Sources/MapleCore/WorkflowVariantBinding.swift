import Foundation

/// An immutable writer and the XMP file used by this branch's decode (#4063).
public struct WorkflowVariantBinding: Sendable {
  let writer: any WorkflowSidecarStoreProtocol
  let sidecarURL: URL
}

public protocol WorkflowVariantSidecarStoreProtocol: WorkflowSidecarStoreProtocol {
  func listWorkflowVariants() async throws -> [WorkflowVariantSidecar]
  func createWorkflowVariant(_ record: SidecarWorkflow, sourceVariantId: String) async throws
  func bindWorkflowVariant(_ variantId: String) async throws -> WorkflowVariantBinding
}

extension XMPSidecarStore: WorkflowVariantSidecarStoreProtocol {
  public func listWorkflowVariants() async throws -> [WorkflowVariantSidecar] {
    try await WorkflowVariantStore(primarySidecarURL: primarySidecarURL).list()
  }
  public func createWorkflowVariant(_ record: SidecarWorkflow, sourceVariantId: String) async throws
  {
    _ = try await readWorkflowXML()
    _ = try await WorkflowVariantStore(primarySidecarURL: primarySidecarURL)
      .create(record, sourceVariantId: sourceVariantId)
  }
  public func bindWorkflowVariant(_ variantId: String) async throws -> WorkflowVariantBinding {
    _ = try await readWorkflowXML()
    let selected = try XMPSidecarStore(
      primarySidecarURL: primarySidecarURL, variantId: variantId, rawURL: rawURL)
    _ = try await selected.readWorkflowXML()
    let name = try WorkflowSidecarCore.variantFilename(
      primaryName: primarySidecarURL.lastPathComponent, variantId: variantId)
    return WorkflowVariantBinding(
      writer: selected,
      sidecarURL: primarySidecarURL.deletingLastPathComponent().appendingPathComponent(name))
  }
}

extension PhotoKitSidecarStore: WorkflowVariantSidecarStoreProtocol {
  public func listWorkflowVariants() async throws -> [WorkflowVariantSidecar] {
    try await writer.listWorkflowVariants()
  }
  public func createWorkflowVariant(_ record: SidecarWorkflow, sourceVariantId: String) async throws
  {
    try await writer.createWorkflowVariant(record, sourceVariantId: sourceVariantId)
  }
  public func bindWorkflowVariant(_ variantId: String) async throws -> WorkflowVariantBinding {
    try await writer.bindWorkflowVariant(variantId)
  }
}
