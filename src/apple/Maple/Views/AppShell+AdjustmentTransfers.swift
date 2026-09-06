import MapleCore
import SwiftUI

private struct BatchAdjustmentLibraryKey: EnvironmentKey {
  static let defaultValue: BatchAdjustmentLibrary? = nil
}

extension EnvironmentValues {
  var batchAdjustmentLibrary: BatchAdjustmentLibrary? {
    get { self[BatchAdjustmentLibraryKey.self] }
    set { self[BatchAdjustmentLibraryKey.self] = newValue }
  }
}

extension AppShell {
  /// Freeze the connected source with the operation. A later navigation must
  /// never redirect a pending write to a different folder or server.
  var batchAdjustmentLibrary: BatchAdjustmentLibrary? {
    let selection = librarySelection
    let source = browseVM.currentSource
    let root = browseVM.currentScopeRoot
    let assets = browseVM.assets
    let scopeID: String
    switch selection {
    case .folder:
      guard let root else { return nil }
      scopeID = "file:" + root.standardizedFileURL.absoluteString
    case .photosFilter: scopeID = "photos:system-library"
    case .smbShare(let share):
      scopeID = "smb:\(share.host)/\(share.share)/\(share.username)"
    case .cloudLibrary(let server, let folder):
      scopeID = "cloud:\(server.absoluteString)/\(folder)"
    case .none, .allSources, .map: return nil
    }
    let store: @MainActor @Sendable (AssetRef) throws -> any SidecarStoreProtocol = { asset in
      if let url = asset.primaryURL {
        guard case .folder = selection, let root,
          url.standardizedFileURL.path.hasPrefix(root.standardizedFileURL.path + "/")
        else { throw BatchAdjustmentError.wrongLibrary }
        return XMPSidecarStore(rawURL: url)
      }
      guard let id = asset.stableID else { throw BatchAdjustmentError.wrongLibrary }
      switch selection {
      case .photosFilter:
        guard asset.thumbnailProvenance == .photoKit else {
          throw BatchAdjustmentError.wrongLibrary
        }
        return try PhotoKitSidecarStore(phassetLocalId: id)
      case .smbShare:
        guard asset.thumbnailProvenance == .smb, let smb = source as? SMBSource
        else { throw BatchAdjustmentError.wrongLibrary }
        return SMBSidecarStore(source: smb, ref: ImageRef(id: id, displayName: asset.displayName))
      case .cloudLibrary(let server, _):
        guard
          asset.thumbnailProvenance == nil || asset.thumbnailProvenance == .cloud(server: server),
          asset.catalog?.serverID == nil || asset.catalog?.serverID == server
        else { throw BatchAdjustmentError.wrongLibrary }
        return CloudSidecarStore(
          server: LocalNetworkResolver.shared.effectiveURL(for: server), assetID: id,
          httpClient: makeAuthenticatedHTTPClient(server: server))
      default: throw BatchAdjustmentError.wrongLibrary
      }
    }
    return BatchAdjustmentLibrary(
      id: scopeID,
      resolve: { target in
        if let asset = assets.first(where: { $0.adjustmentTransferID == target.id }) {
          _ = try store(asset)
          return asset
        }
        if let url = target.url {
          guard target.id == url.standardizedFileURL.absoluteString else {
            throw BatchAdjustmentError.invalidOperation
          }
          let asset = AssetRef(url: url, scopeParentURL: root)
          _ = try store(asset)
          return asset
        }
        // SMB IDs require the connected source's current path map. Never
        // reconstruct an unknown ID: its fallback path could create a sidecar
        // for a deleted photo. Reopen the containing folder before retrying.
        if case .smbShare = selection { throw CocoaError(.fileNoSuchFile) }
        guard let source else { throw BatchAdjustmentError.wrongLibrary }
        let provenance: AssetRef.ThumbnailProvenance
        switch selection {
        case .photosFilter: provenance = .photoKit
        case .smbShare: provenance = .smb
        case .cloudLibrary(let server, _): provenance = .cloud(server: server)
        default: throw BatchAdjustmentError.wrongLibrary
        }
        let ref = ImageRef(id: target.id, displayName: target.name)
        return AssetRef(
          displayName: target.name, hintExtension: target.hintExtension, stableID: target.id,
          explicitIsRaw: target.isRaw, thumbnailProvenance: provenance,
          bytesProvider: { try await source.rawBytes(for: ref) })
      },
      session: { asset in
        sessions[asset.id]
      }, store: store)
  }
}
