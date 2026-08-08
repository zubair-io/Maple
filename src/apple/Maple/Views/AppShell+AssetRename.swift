// AppShell+AssetRename.swift — inline single-asset rename (#2638).
//
// UI + wiring only, per the ticket's scope note: every actual file-op lives
// in the already-merged `MapleCore` engines (`LocalFileOperations.relocate`,
// `SMBSource.renameAsset` → `SMBFileOperations.relocate`) or the API
// (`RemoteCatalog.renameAsset` → `POST /api/assets/:id/rename`, #2636).
// This file owns:
//   • routing a rename by source kind (Filesystem / SMB / Cloud / PhotoKit)
//   • rebuilding the renamed `AssetRef` and reconciling every place that was
//     keyed on the OLD one — `browseVM.assets` (grid, in place, no rescan),
//     `browseVM.selectedID`/`selectedIDs`, and any live `EditSession`
//   • the `\.assetRename` environment action's state (`renamingAssetID`,
//     `renameError`, both declared on `AppShell` itself)
//
// `AssetRef.id` is minted fresh by every public initializer (there is no
// id-preserving one — see `AssetRef.swift`'s doc comment: "a UUID minted
// per session... not a content hash"), so a rename necessarily produces a
// NEW id. That's consistent with how the rest of the app already treats
// identity: `applyRenamed` below reconciles the handful of places that hold
// the old one, the same shape `AppShell+FolderContextMenu.swift`'s
// `renameLocalFolder` already uses for `librarySelection`.

import SwiftUI
import MapleCore

@MainActor
extension AppShell {

    // MARK: - Environment action entry points

    /// Begin inline rename for `asset`. No-op (via `renameUnsupportedReason`)
    /// for a source that can't be renamed — callers should check that first
    /// to explain why the affordance is disabled rather than silently doing
    /// nothing.
    func beginRename(for asset: AssetRef) {
        renameError = renameUnsupportedReason(for: asset)
        guard renameError == nil else { return }
        renamingAssetID = asset.id
    }

    func cancelRename() {
        renamingAssetID = nil
        renameError = nil
    }

    /// `nil` when `asset`'s source supports rename; otherwise the reason to
    /// show the user. PhotoKit assets have no user-writable path (design
    /// doc: "PhotoKit → not supported" — surface WHY, not a silent failure).
    /// A Cloud asset that hasn't been resolved through the Timeline/Search
    /// flow (`asset.catalog == nil`) has no known Mongo asset id to address
    /// `/api/assets/:id/rename` with — same precondition the info pane's
    /// enrichment fetch and `CloudSidecarStore` XMP writes already have.
    func renameUnsupportedReason(for asset: AssetRef) -> String? {
        if isPhotoKitAsset(asset) {
            return "PhotoKit photos have no file on disk Maple can rename — rename from the Photos app instead."
        }
        if asset.primaryURL == nil, asset.catalog == nil, !(browseVM.currentSource is SMBSource) {
            return "This photo hasn't finished indexing on the server yet — rename isn't available until it has."
        }
        return nil
    }

    /// Not `private`: `AppShell+AssetDrop.swift` (#2646) reuses this exact
    /// "no user-writable path" test to reject PhotoKit as a drop target
    /// before attempting any relocate.
    func isPhotoKitAsset(_ asset: AssetRef) -> Bool {
        if asset.thumbnailProvenance == .photoKit { return true }
        return asset.primaryURL == nil && asset.catalog == nil && browseVM.currentSource is PhotoKitSource
    }

    /// Commit a rename of `asset` to `newFilename` (the full filename,
    /// stem + extension — the field preserves the extension by default and
    /// the caller has already warned/confirmed before letting a changed one
    /// reach here). Routes by source kind, then reconciles grid/selection/
    /// session state on success.
    func commitRename(asset: AssetRef, to newFilename: String) {
        guard FilenameValidation.isValidFolderName(newFilename) else {
            renameError = FilenameValidation.invalidNameMessage
            return
        }
        if let reason = renameUnsupportedReason(for: asset) {
            renameError = reason
            return
        }
        renameError = nil
        Task { @MainActor in
            do {
                let newAsset = try await performRename(asset: asset, to: newFilename)
                applyRenamed(oldID: asset.id, newAsset: newAsset)
                renamingAssetID = nil
                renameError = nil
            } catch {
                renameError = error.localizedDescription
            }
        }
    }

    // MARK: - Routing

    private func performRename(asset: AssetRef, to newFilename: String) async throws -> AssetRef {
        if asset.catalog != nil {
            return try await renameCloudAsset(asset, to: newFilename)
        }
        if let url = asset.primaryURL {
            return try await renameLocalAsset(asset, url: url, to: newFilename)
        }
        if browseVM.currentSource is SMBSource {
            return try await renameSMBAsset(asset, to: newFilename)
        }
        throw FileOperationError.unsupportedSource("rename is not available for this asset")
    }

    // MARK: - Filesystem

    private func renameLocalAsset(_ asset: AssetRef, url: URL, to newFilename: String) async throws -> AssetRef {
        let scope = asset.scopeParentURL ?? url.deletingLastPathComponent()
        let accessing = scope.startAccessingSecurityScopedResource()
        defer { if accessing { scope.stopAccessingSecurityScopedResource() } }
        let destinationDir = url.deletingLastPathComponent()
        let outcome = try await LocalFileOperations.relocate(
            url, to: destinationDir, newBasename: newFilename, mode: .move, collision: .fail)
        let newURL = URL(fileURLWithPath: outcome.primaryPath)
        return AssetRef(url: newURL, scopeParentURL: asset.scopeParentURL)
    }

    // MARK: - SMB

    private func renameSMBAsset(_ asset: AssetRef, to newFilename: String) async throws -> AssetRef {
        guard let source = browseVM.currentSource as? SMBSource,
              let mapleID = asset.stableID,
              let bytesProvider = asset.bytesProvider else {
            throw FileOperationError.sourceMissing("SMB share is not connected")
        }
        let ref = ImageRef(id: mapleID, displayName: asset.displayName, url: nil)
        _ = try await source.renameAsset(ref, to: newFilename)
        let ext = (newFilename as NSString).pathExtension.lowercased()
        // Reuse the OLD `bytesProvider` verbatim: it closes over the SAME
        // `ImageRef` (maple_id, unchanged by a rename) and resolves the
        // share-relative path at CALL time via `SMBSource.path(for:)` —
        // which `renameAsset` above just updated — so it already points at
        // the new location without rebuilding anything.
        return AssetRef(
            displayName: newFilename,
            hintExtension: ext.isEmpty ? nil : ext,
            stableID: mapleID,
            explicitIsRaw: asset.explicitIsRaw,
            thumbnailProvenance: asset.thumbnailProvenance,
            displayPreviewProvider: asset.displayPreviewProvider,
            bytesProvider: bytesProvider
        )
    }

    // MARK: - Cloud

    private func renameCloudAsset(_ asset: AssetRef, to newFilename: String) async throws -> AssetRef {
        guard let catalog = asset.catalog, let assetID = asset.stableID,
              let bytesProvider = asset.bytesProvider else {
            throw FileOperationError.unsupportedSource(
                "This photo hasn't finished indexing on the server yet — rename isn't available until it has.")
        }
        let httpClient = makeAuthenticatedHTTPClient(server: catalog.serverID)
        let effectiveServer = LocalNetworkResolver.shared.effectiveURL(for: catalog.serverID)
        let remote = RemoteCatalog(http: httpClient, server: effectiveServer)
        let result = try await remote.renameAsset(assetID: assetID, newFilename: newFilename)
        switch result {
        case .ok(let response):
            let ext = (newFilename as NSString).pathExtension.lowercased()
            return AssetRef(
                displayName: newFilename,
                hintExtension: ext.isEmpty ? nil : ext,
                stableID: assetID,
                explicitIsRaw: asset.explicitIsRaw,
                thumbnailProvenance: asset.thumbnailProvenance,
                displayPreviewProvider: asset.displayPreviewProvider,
                // The server response has no fresh `address` (slug:relPath)
                // for the new location — nil is the CORRECT value here, not
                // a regression: `InfoPanelView.loadEnrichment` already falls
                // back to a by-fspath lookup when `catalog.address` is nil.
                catalog: CatalogRef(
                    serverID: catalog.serverID, folderID: catalog.folderID,
                    absPath: response.newAbsPath, address: nil),
                bytesProvider: bytesProvider
            )
        case .skipped:
            throw FileOperationError.destinationExists(newFilename)
        case .invalid(let message):
            throw FileOperationError.invalidName(message)
        case .notFound:
            throw FileOperationError.sourceMissing("This photo no longer exists on the server")
        }
    }

    // MARK: - Post-commit reconciliation

    /// Patches `browseVM.assets` IN PLACE (same index — no rescan),
    /// repoints selection, and rebuilds any live `EditSession` at the new
    /// id via the existing lazy `ensureSession(for:)` — which resolves the
    /// right remote sidecar store per source kind and calls `loadSidecar()`,
    /// so the session hydrates from the sidecar the relocate engine already
    /// moved rather than needing its in-memory state hand-carried over.
    private func applyRenamed(oldID: AssetRef.ID, newAsset: AssetRef) {
        if let idx = browseVM.assets.firstIndex(where: { $0.id == oldID }) {
            browseVM.assets[idx] = newAsset
        }
        let wasSelected = browseVM.selectedID == oldID
        if browseVM.selectedIDs.contains(oldID) {
            browseVM.selectedIDs.remove(oldID)
            browseVM.selectedIDs.insert(newAsset.id)
        }
        sessions.removeValue(forKey: oldID)
        if wasSelected {
            browseVM.selectedID = newAsset.id
        }
        ensureSession(for: newAsset)
    }
}
