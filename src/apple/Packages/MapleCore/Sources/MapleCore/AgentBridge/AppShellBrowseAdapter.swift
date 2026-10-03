import Foundation
import MapleAgentWire

@MainActor
public final class AppShellBrowseAdapter: AgentBrowseDelegate {
  public weak var browseVM: BrowseViewModel?
  public var getSessions: (@MainActor () -> [AssetRef.ID: EditSession])?
  public var ensureSessionHandler: (@MainActor (AssetRef) -> EditSession)?
  public var openPhotoHandler: (@MainActor (AssetRef) async throws -> EditSession)?

  public init(
    browseVM: BrowseViewModel? = nil,
    getSessions: (@MainActor () -> [AssetRef.ID: EditSession])? = nil,
    ensureSessionHandler: (@MainActor (AssetRef) -> EditSession)? = nil,
    openPhotoHandler: (@MainActor (AssetRef) async throws -> EditSession)? = nil
  ) {
    self.browseVM = browseVM
    self.getSessions = getSessions
    self.ensureSessionHandler = ensureSessionHandler
    self.openPhotoHandler = openPhotoHandler
  }

  public var browseAssets: [AssetRef] {
    browseVM?.assets ?? []
  }

  public var selectedAssetID: AssetRef.ID? {
    browseVM?.selectedID
  }

  public var activeCollectionName: String? {
    browseVM?.currentScopeRoot?.lastPathComponent ?? "Library"
  }

  public var activeFolderPath: String? {
    browseVM?.currentScopeRoot?.path
  }

  public func session(for asset: AssetRef) -> EditSession? {
    getSessions?()[asset.id]
  }

  public func ensureSession(for asset: AssetRef) -> EditSession {
    ensureSessionHandler?(asset) ?? EditSession(asset: asset)
  }

  public func openPhoto(assetID: AssetRef.ID) async throws -> EditSession {
    guard let asset = browseAssets.first(where: { $0.id == assetID }) else {
      throw AgentError(
        code: "asset_not_found", message: "No photo found with ID `\(assetID.uuidString)`.")
    }
    guard let handler = openPhotoHandler else {
      throw AgentError(
        code: "browse_unavailable", message: "Photo opening is currently unavailable.")
    }
    return try await handler(asset)
  }

  public func updateCulling(
    assetID: AssetRef.ID,
    mutate: @Sendable @escaping (inout CullingState) -> Void
  ) async throws -> CullingState {
    guard let asset = browseAssets.first(where: { $0.id == assetID }) else {
      throw AgentError(
        code: "asset_not_found", message: "No photo found with ID `\(assetID.uuidString)`.")
    }
    let session = ensureSession(for: asset)
    if !session.hasLoadedSidecar {
      await session.loadSidecar()
    }
    var c = session.culling
    mutate(&c)
    session.culling = c
    await session.flushPendingSidecarWrite()
    return c
  }
}
