// PhotoKit-provenance editor persistence (#2555/#4047). The canonical App
// Support file is also the XMP source used by BackupEngine companion upload.
// Reuse the filesystem writer's coordination, debounce, semantic checkpoints,
// XML preservation and failed-publication retry rather than maintain two journals.
import Foundation
import MapleBackup

public actor PhotoKitSidecarStore: WorkflowSidecarStoreProtocol {
  private let phassetLocalId: String
  private let sidecars: AppSupportSidecarStore
  let writer: XMPSidecarStore

  public init(phassetLocalId: String, sidecars: AppSupportSidecarStore) {
    self.phassetLocalId = phassetLocalId
    self.sidecars = sidecars
    self.writer = XMPSidecarStore(sidecarURL: sidecars.sidecarURL(phassetLocalId: phassetLocalId))
  }

  public init(phassetLocalId: String) throws {
    self.init(
      phassetLocalId: phassetLocalId,
      sidecars: AppSupportSidecarStore(root: try AppSupportSidecarStore.defaultRoot()))
  }

  public func load() async throws -> (AdjustmentModel, CullingState) {
    try await loadIfPresent() ?? (.default, CullingState())
  }

  public func loadIfPresent() async throws -> (AdjustmentModel, CullingState)? {
    // Retain AppSupportSidecarStore's explicit UTF-8 corruption error contract.
    _ = try sidecars.read(phassetLocalId: phassetLocalId)
    return try await writer.loadIfPresent()
  }

  public func update(model: AdjustmentModel, culling: CullingState) async {
    await writer.update(model: model, culling: culling)
  }

  public func flush() async { await writer.flush() }

  public func writeConfirmed(model: AdjustmentModel, culling: CullingState) async throws {
    try await writer.writeConfirmed(model: model, culling: culling)
  }

  public func commitSemantic(
    model: AdjustmentModel, culling: CullingState, action: String, label: String
  ) async throws {
    try await writer.commitSemantic(model: model, culling: culling, action: action, label: label)
  }

  public func readWorkflowXML() async throws -> String? {
    try await writer.readWorkflowXML()
  }

  public func publishWorkflow(_ command: WorkflowPublication) async throws -> String {
    try await writer.publishWorkflow(command)
  }

  public func errors() async -> AsyncStream<Error> { await writer.errors() }
}
