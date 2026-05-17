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
    /// Last-modified time in epoch seconds. The server stores
    /// `AssetDoc.mtime` in milliseconds (from `stat.mtimeMs`) but the
    /// `/api/assets` list endpoint divides by 1000 before responding so
    /// it lines up with `Date(timeIntervalSince1970:)` on the consumer
    /// side. Crossing this boundary in ms would put
    /// `contentModificationDate` in the year 55,000.
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

/// Single-asset metadata returned by GET /api/assets/:id. Mirrors the
/// per-asset shape `assets.ts` emits; the route is older than the
/// `/api/assets` list endpoint and still returns `mtime` in
/// milliseconds.
public struct AssetMetadata: Codable, Sendable, Equatable {
    public let id: String
    public let folderID: String
    public let filename: String
    public let absPath: String
    public let size: Int64
    /// Epoch MILLISECONDS — convert with `Date(timeIntervalSince1970:
    /// Double(mtimeMS) / 1000.0)` for SwiftUI `contentModificationDate`.
    public let mtimeMS: Int64
    public let rating: Int

    public init(id: String, folderID: String, filename: String, absPath: String,
                size: Int64, mtimeMS: Int64, rating: Int) {
        self.id = id
        self.folderID = folderID
        self.filename = filename
        self.absPath = absPath
        self.size = size
        self.mtimeMS = mtimeMS
        self.rating = rating
    }

    /// Convenience: the modification date as a Foundation `Date`,
    /// computed from the server's millisecond timestamp.
    public var contentModificationDate: Date {
        Date(timeIntervalSince1970: Double(mtimeMS) / 1000.0)
    }

    private enum CodingKeys: String, CodingKey {
        case id, filename, rating, size
        case folderID = "folder_id"
        case absPath = "abs_path"
        case mtimeMS = "mtime"
    }
}
