// AssetChangeItems.swift — what one asset-level change fans out to (#3563).
//
// A change-feed row names an ASSET, but the mount shows two items for it:
// the RAW and its `.xmp` sibling. Refreshing only the RAW item (the pre-#3563
// behaviour of both `WorkingSetChangeResolver` and `FolderChangeMatching`)
// left the sidecar item's version — and so the materialised bytes — frozen
// at whatever the last full enumeration saw, which is exactly how a web edit
// never reached a mounted folder. Both change paths route through here so
// they can't drift again.

import FileProvider
import Foundation

enum AssetChangeItems {
    /// Items for an asset the server still knows: the RAW item, plus its
    /// sidecar item when metadata carries a sidecar stat. When the server
    /// says outright that there is no sidecar (`has_xmp == false`) the
    /// canonical sidecar identifier is retired instead, so a sidecar deleted
    /// on the server disappears from the mount too — harmless when the OS
    /// never had that item. A server that reports neither (predates both
    /// fields) leaves any mounted sidecar untouched.
    ///
    /// `includeDerived` adds the asset's `.maple/thumbs/` and
    /// `.maple/previews/` entries (#3571). The folder enumerators pass
    /// `true`: the derived containers hang off the folder being enumerated
    /// and a browsing client reads them next to the photos. The working set
    /// leaves it `false` — its members are RAWs and sidecars, and tripling
    /// every change page with derived-cache entries buys nothing there.
    static func resolved(meta: AssetMetadata,
                         parent: NSFileProviderItemIdentifier,
                         includeDerived: Bool = false)
        -> (updates: [MapleItem], deletes: [NSFileProviderItemIdentifier]) {
        let asset = MapleItem(assetMetadata: meta, parent: parent)
        let derived = includeDerived ? derivedItems(meta: meta, parent: parent) : []
        if let sidecar = MapleItem(sidecarForAsset: meta, parent: parent) {
            return ([asset, sidecar] + derived, [])
        }
        if meta.hasXMP == false {
            return ([asset] + derived, [MapleItem.sidecarIdentifier(assetID: meta.id)])
        }
        return ([asset] + derived, [])
    }

    /// The asset's `.maple/thumbs/` and `.maple/previews/` entries (#3571),
    /// re-emitted with the same version seed the derived enumerators use
    /// (sidecar mtime, else RAW mtime) so a server-side edit — which moves
    /// the sidecar mtime — makes the OS refetch the derived bytes. Only
    /// when the asset's parent is a real folder: the derived containers hang
    /// off that folder's `.maple/`; any other parent yields nothing.
    static func derivedItems(meta: AssetMetadata,
                             parent: NSFileProviderItemIdentifier) -> [MapleItem] {
        guard let parsed = try? FileProviderIdentifier(rawValue: parent.rawValue),
              case .folder(let folderID, let relativePath) = parsed else { return [] }
        let seed = meta.xmpMtime ?? meta.contentModificationDate
        let thumbsDir = NSFileProviderItemIdentifier(
            FileProviderIdentifier.mapleThumbsDir(folderID: folderID, parentRelativePath: relativePath).rawValue)
        let previewsDir = NSFileProviderItemIdentifier(
            FileProviderIdentifier.maplePreviewsDir(folderID: folderID, parentRelativePath: relativePath).rawValue)
        return [
            MapleDerivedKind.thumbs.item(assetID: meta.id, rawBasename: meta.filename,
                                         modified: seed, parentIdentifier: thumbsDir),
            MapleDerivedKind.previews.item(assetID: meta.id, rawBasename: meta.filename,
                                           modified: seed, parentIdentifier: previewsDir),
        ]
    }

    /// Identifiers to delete for an asset the server no longer has: the
    /// RAW and its canonical sidecar (trashing a RAW takes its `.xmp` along).
    static func deleted(assetID: String) -> [NSFileProviderItemIdentifier] {
        [
            NSFileProviderItemIdentifier(FileProviderIdentifier.asset(assetID).rawValue),
            MapleItem.sidecarIdentifier(assetID: assetID),
            NSFileProviderItemIdentifier(FileProviderIdentifier.thumb(assetID: assetID).rawValue),
            NSFileProviderItemIdentifier(FileProviderIdentifier.preview(assetID: assetID).rawValue),
        ]
    }
}
