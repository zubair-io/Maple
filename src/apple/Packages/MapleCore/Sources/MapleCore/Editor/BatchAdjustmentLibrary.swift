import Foundation

extension AssetRef {
  /// Session UUIDs change on reload. Ledger identity must come from the source.
  public var adjustmentTransferID: String? {
    primaryURL?.standardizedFileURL.absoluteString ?? stableID
  }

  public var adjustmentTransferTarget: BatchAdjustmentTarget? {
    guard let id = adjustmentTransferID, !isVideo, !isAudio, !isStub else { return nil }
    return BatchAdjustmentTarget(
      id: id, name: displayName, url: primaryURL, hintExtension: hintExtension, isRaw: isRaw)
  }
}

/// A connected library supplies its existing sidecar and original-byte routes.
/// The closure captures that library, so navigation cannot redirect an operation
/// to another server/share. Production shares one ledger across all windows.
@MainActor
public struct BatchAdjustmentLibrary {
  public let id: String
  public let resolve: @MainActor @Sendable (BatchAdjustmentTarget) throws -> AssetRef
  public let session: @MainActor @Sendable (AssetRef) -> EditSession?
  public let store: @MainActor @Sendable (AssetRef) throws -> any SidecarStoreProtocol

  public init(
    id: String,
    resolve: @escaping @MainActor @Sendable (BatchAdjustmentTarget) throws -> AssetRef,
    session: @escaping @MainActor @Sendable (AssetRef) -> EditSession?,
    store: @escaping @MainActor @Sendable (AssetRef) throws -> any SidecarStoreProtocol
  ) {
    self.id = id
    self.resolve = resolve
    self.session = session
    self.store = store
  }

  public func readModel(for asset: AssetRef) async throws -> AdjustmentModel {
    if let live = session(asset) {
      await live.loadSidecar()
      guard live.hasLoadedSidecar else {
        throw live.sidecarError ?? BatchAdjustmentError.invalidOperation
      }
      return live.model
    }
    let scope = asset.scopeParentURL ?? asset.primaryURL
    let accessing = scope?.startAccessingSecurityScopedResource() ?? false
    defer { if accessing { scope?.stopAccessingSecurityScopedResource() } }
    return try await store(asset).loadIfPresent()?.0 ?? .default
  }

  public func prepare(
    target: BatchAdjustmentTarget, request: BatchAdjustmentRequest
  ) async throws -> PreparedAdjustmentTransfer {
    let asset = try resolve(target)
    let baseline =
      request.relativeWhiteBalance && request.groups.contains(.whiteBalance)
      ? try await WhiteBalanceTransferBaseline.read(asset: asset) : nil
    let before = try await readModel(for: asset)
    let patch = try AdjustmentTransfer.prepare(
      source: request.source, groups: request.groups,
      relativeWhiteBalance: request.relativeWhiteBalance,
      sourceBaseline: request.sourceBaseline, targetBaseline: baseline)
    return PreparedAdjustmentTransfer(model: patch.model, groupIDs: patch.groupIDs, before: before)
  }

  public func apply(target: BatchAdjustmentTarget, patch: PreparedAdjustmentTransfer) async throws {
    let asset = try resolve(target)
    let scope = asset.scopeParentURL ?? asset.primaryURL
    let accessing = scope?.startAccessingSecurityScopedResource() ?? false
    defer { if accessing { scope?.stopAccessingSecurityScopedResource() } }
    if let url = asset.primaryURL, !FileManager.default.fileExists(atPath: url.path) {
      throw CocoaError(.fileNoSuchFile)
    }
    if let live = session(asset) {
      try await live.applyAdjustmentTransfer(patch)
      return
    }
    let destination = try store(asset)
    let (model, culling) = try await destination.loadIfPresent() ?? (.default, CullingState())
    try patch.validate(current: model)
    try await destination.writeConfirmed(model: patch.applying(to: model), culling: culling)
  }
}
