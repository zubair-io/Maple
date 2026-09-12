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
    static func resolved(meta: AssetMetadata,
                         parent: NSFileProviderItemIdentifier)
        -> (updates: [MapleItem], deletes: [NSFileProviderItemIdentifier]) {
        let asset = MapleItem(assetMetadata: meta, parent: parent)
        if let sidecar = MapleItem(sidecarForAsset: meta, parent: parent) {
            return ([asset, sidecar], [])
        }
        if meta.hasXMP == false {
            return ([asset], [MapleItem.sidecarIdentifier(assetID: meta.id)])
        }
        return ([asset], [])
    }

    /// Identifiers to delete for an asset the server no longer has: the
    /// RAW and its canonical sidecar (trashing a RAW takes its `.xmp` along).
    static func deleted(assetID: String) -> [NSFileProviderItemIdentifier] {
        [
            NSFileProviderItemIdentifier(FileProviderIdentifier.asset(assetID).rawValue),
            MapleItem.sidecarIdentifier(assetID: assetID),
        ]
    }
}
