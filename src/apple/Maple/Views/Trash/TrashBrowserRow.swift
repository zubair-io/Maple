// TrashBrowserRow.swift — one row in the in-app Trash browser (#2653),
// source-agnostic over `MapleCore.TrashedItem` (Local/SMB) and
// `RemoteCatalog.TrashItem` (Cloud).

import Foundation
import MapleCore

struct TrashBrowserRow: Identifiable, Equatable {
    let id: String
    let displayName: String
    let trashedDate: Date?
    let size: Int64

    init(local item: TrashedItem) {
        self.id = item.id
        self.displayName = item.displayName
        self.trashedDate = item.trashedDate
        self.size = item.size
    }

    /// Fails when the trashed row is not an indexed image (`assetID == nil`,
    /// #2546) — every Cloud action this row backs (`restoreAsset` /
    /// `deleteAsset`) addresses the server by asset ID, so a nil-assetID row
    /// is non-actionable here. Call sites `compactMap`, mirroring
    /// `MapleItem.init?(trashed:)`'s handling of the same rows.
    init?(cloud item: TrashItem) {
        guard let assetID = item.assetID, !assetID.isEmpty else { return nil }
        self.id = assetID
        self.displayName = item.filename
        self.trashedDate = item.deletedAt
        self.size = item.size
    }
}

/// Outcome of a Restore / Delete Permanently action on one row (#2653,
/// extended for #2750's Cloud `intent` adoption). `.stale` is the 409
/// state-mismatch case: the Cloud server's `?intent=trash|purge` refused
/// because the asset's CURRENT state doesn't match what this row assumed
/// (e.g. it was restored elsewhere between listing and this call) — the
/// action did NOT proceed (never a silent purge of a live photo), and the
/// row is removed from view since it no longer belongs in this trash list,
/// with `reason` shown so the removal isn't unexplained.
enum TrashRowActionOutcome {
    case succeeded
    case stale(reason: String)
    case failed(String)
}
