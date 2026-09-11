// AppShell+SearchPreviewAssets.swift — #3551.
//
// A Search result is one asset from anywhere in the account; the Search grid
// is not a folder listing, so it has no sibling list to hand Preview. Before
// this file the iPhone Search tab pushed Preview with `assets: [ref]` — a
// one-cell filmstrip and no prev/next. Preview's swipe domain should be the
// FOLDER the tapped asset lives in, exactly what a Library-tab open gets from
// `browseVM.assets`: list the parent directory on the asset's own server
// (`CloudSource.listDir`), build lazy display-only refs for its images (the
// same shape `AppShell+TimelinePreviewAssets` builds for Timeline cells — no
// `EditSession`, no download box; those come from `ensureSession(for:)` when
// a sibling becomes the shown asset), and splice the tapped ref itself in at
// its own position so the already-sessioned ref is what Preview shows.

import Foundation
import MapleCore

@MainActor
extension AppShell {
    /// The containing-folder sibling list for a Search-opened asset, with
    /// `ref` spliced in at its own position. `[ref]` when the ref carries no
    /// catalog identity or the listing fails — Preview then degrades to the
    /// single-asset domain it had before, never an empty strip.
    func searchPreviewSiblingAssets(for ref: AssetRef, server: URL) async -> [AssetRef] {
        guard let catalog = ref.catalog else { return [ref] }
        let parentPath = (catalog.absPath as NSString).deletingLastPathComponent
        let source = CloudSource(
            server: LocalNetworkResolver.shared.effectiveURL(for: server),
            folderID: catalog.folderID,
            libraryPath: parentPath,
            httpClient: makeAuthenticatedHTTPClient(server: server))
        guard let listing = try? await source.listDir(absPath: parentPath) else { return [ref] }
        let siblings = listing.images.map { image in
            Self.folderSiblingAssetRef(image, folderID: catalog.folderID, server: server, source: source)
        }
        return AppShellVM.splicingTappedAsset(ref, into: siblings)
    }

    /// Lazy, display-only cloud ref for one folder entry. Mirrors the
    /// Timeline sibling builder: `thumbnailProvenance` + `displayPreviewProvider`
    /// so the display tier and `ensureSession(for:)` never depend on an
    /// ambient source, and a `catalog` so the info pane can fetch its detail.
    private static func folderSiblingAssetRef(
        _ image: FsImageEntry, folderID: String, server: URL, source: CloudSource
    ) -> AssetRef {
        let id = "fs:\(image.path)"
        let imageRef = ImageRef(id: id, displayName: image.name, url: nil)
        let ext = (image.name as NSString).pathExtension.lowercased()
        return AssetRef(
            displayName: image.name,
            hintExtension: ext.isEmpty ? nil : ext,
            stableID: id,
            thumbnailProvenance: .cloud(server: server),
            displayPreviewProvider: { try await source.preview(for: imageRef) },
            catalog: CatalogRef(
                serverID: server, folderID: folderID, absPath: image.path, address: nil),
            bytesProvider: { try await source.rawBytes(for: imageRef) }
        )
    }
}
