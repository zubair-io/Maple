/**
 AssetChange — DTOs for the File Provider push channel (Phase 5b).

 Mirrors the server's `AssetChangeDoc` and the GET /api/changes /
 GET /api/assets response shapes. The extension consumes these via
 `RemoteCatalog.listChanges(since:limit:)` and
 `RemoteCatalog.listAssets(...)`.
 */

import Foundation

public enum AssetChangeKind: String, Codable, Sendable, Equatable {
    case create
    case update
    case delete
    case restore
}

public struct AssetChange: Codable, Sendable, Equatable {
    public let cursor: Int64
    public let assetID: String?
    public let folderID: String?
    public let kind: AssetChangeKind
    public let absPath: String?
    public let at: Date

    public init(cursor: Int64, assetID: String?, folderID: String?,
                kind: AssetChangeKind, absPath: String?, at: Date) {
        self.cursor = cursor
        self.assetID = assetID
        self.folderID = folderID
        self.kind = kind
        self.absPath = absPath
        self.at = at
    }

    private enum CodingKeys: String, CodingKey {
        case cursor, kind, at
        case assetID = "asset_id"
        case folderID = "folder_id"
        case absPath = "abs_path"
    }
}

public struct ChangesPage: Codable, Sendable, Equatable {
    public let changes: [AssetChange]
    public let nextCursor: Int64?

    public init(changes: [AssetChange], nextCursor: Int64?) {
        self.changes = changes
        self.nextCursor = nextCursor
    }

    private enum CodingKeys: String, CodingKey {
        case changes
        case nextCursor = "next_cursor"
    }
}

public struct AssetListEntry: Codable, Sendable, Equatable {
    public let id: String
    public let folderID: String
    public let filename: String
    public let absPath: String
    public let mtime: Int64
    public let rating: Int
    public let hasXMP: Bool

    public init(id: String, folderID: String, filename: String, absPath: String,
                mtime: Int64, rating: Int, hasXMP: Bool) {
        self.id = id
        self.folderID = folderID
        self.filename = filename
        self.absPath = absPath
        self.mtime = mtime
        self.rating = rating
        self.hasXMP = hasXMP
    }

    private enum CodingKeys: String, CodingKey {
        case id, filename, mtime, rating
        case folderID = "folder_id"
        case absPath = "abs_path"
        case hasXMP = "has_xmp"
    }
}

public struct AssetListResponse: Codable, Sendable, Equatable {
    public let assets: [AssetListEntry]

    public init(assets: [AssetListEntry]) {
        self.assets = assets
    }
}
