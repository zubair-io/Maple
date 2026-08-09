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

    init(cloud item: TrashItem) {
        self.id = item.assetID
        self.displayName = item.filename
        self.trashedDate = item.deletedAt
        self.size = item.size
    }
}
