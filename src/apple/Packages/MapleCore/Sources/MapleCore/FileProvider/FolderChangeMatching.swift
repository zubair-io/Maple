// FolderChangeMatching.swift — folder-scoped change enumeration support (#2547).
//
// Folder containers previously reported a constant sync anchor and an
// empty `enumerateChanges`, so signalling a folder told the OS "nothing
// changed since anchor 0" and no delta could ever reach an open Finder
// window. These helpers let a folder answer the same question the
// working set already answers, scoped to its own directory.
//
// The anchor is the global monotonic server change cursor — the same
// value `WorkingSetEnumerator` uses, encoded identically, so the two can
// never disagree about what a cursor means.

import Foundation
import FileProvider

public enum FolderChangeMatching {
    /// Encode a server cursor as a sync anchor. Matches
    /// `WorkingSetEnumerator.anchor(_:)` byte for byte.
    public static func anchor(_ cursor: Int64) -> NSFileProviderSyncAnchor {
        NSFileProviderSyncAnchor(Data(String(cursor).utf8))
    }

    /// Decode a sync anchor back to a server cursor. An unparseable anchor
    /// decodes to 0, which replays from the beginning rather than skipping
    /// changes — the safe direction to fail.
    public static func parseAnchor(_ anchor: NSFileProviderSyncAnchor) -> Int64 {
        guard let text = String(data: anchor.rawValue, encoding: .utf8),
              let cursor = Int64(text) else { return 0 }
        return cursor
    }

    /// True when `change` describes an item sitting DIRECTLY in the folder
    /// identified by `(folderID, relativePath)`.
    ///
    /// `change.relativePath` is the file's path relative to the library
    /// root and includes the filename, so the containing directory is its
    /// `deletingLastPathComponent`. A root-level asset reduces to `""`,
    /// which is the folder-root identifier — the same derivation
    /// `MapleItem.init(stubAssetID:...)` performs.
    ///
    /// A row with no `relativePath` (legacy payload, or a path the server
    /// could not reconcile against the folder root) cannot be placed, so no
    /// folder claims it. Those rows still reach the OS through the working
    /// set, which parents them at `.workingSet`.
    public static func belongs(change: AssetChange,
                               toFolderID folderID: String,
                               relativePath: String) -> Bool {
        guard change.folderID == folderID,
              let rel = change.relativePath else { return false }
        return (rel as NSString).deletingLastPathComponent == relativePath
    }

    /// Split one page of changes into the observer's two buckets, keeping
    /// only rows belonging to this folder. Rows without an asset id carry
    /// no identity we can report and are skipped.
    public static func partition(changes: [AssetChange],
                                 folderID: String,
                                 relativePath: String)
        -> (updates: [MapleItem], deletes: [NSFileProviderItemIdentifier]) {
        let mine = changes.filter {
            belongs(change: $0, toFolderID: folderID, relativePath: relativePath)
        }
        let updates = mine.compactMap { change -> MapleItem? in
            guard let assetID = change.assetID, change.kind != .delete else { return nil }
            return MapleItem(stubAssetID: assetID,
                             cursor: change.cursor,
                             folderID: change.folderID,
                             relativePath: change.relativePath)
        }
        let deletes = mine.compactMap { change -> NSFileProviderItemIdentifier? in
            guard let assetID = change.assetID, change.kind == .delete else { return nil }
            return NSFileProviderItemIdentifier(FileProviderIdentifier.asset(assetID).rawValue)
        }
        return (updates, deletes)
    }
}
