/**
 AssetChange — DTOs for the File Provider push channel (Phase 5b).

 Mirrors the server's `AssetChangeDoc` and the GET /api/changes /
 GET /api/assets response shapes. The extension consumes these via
 `RemoteCatalog.listChanges(since:limit:)` and
 `RemoteCatalog.listAssets(...)`.
 */

import Foundation

/// Canonical on-disk location record for an asset. Mirrors the server's
/// `FileInfo` entry in `src/api/src/db/schema.ts`. Multiple entries are
/// alternate observations of the same content-addressed asset; entry 0 is
/// canonical for path / cache resolution. `deletedAt` is per-entry so the
/// asset row survives one location being unlinked while another stays live.
///
/// Decoded from the wire keys `{path, filename, library_id, deleted_at}`.
/// `path` is POSIX-separated by contract; consumers on a host where
/// `path.separator != "/"` MUST split on `/` before re-joining with the
/// platform separator (see `assetAbsPath`).
public struct FileInfo: Codable, Equatable, Sendable {
    /// Directory relative to the library root, POSIX-separated.
    /// Empty string for files at the library root.
    public let path: String
    /// File name with extension, e.g. `"IMG_001.dng"`.
    public let filename: String
    /// Hex ObjectId of the registered library this entry lives under.
    public let libraryID: String
    /// ISO timestamp when this specific location was unlinked. `nil` when
    /// the entry is live.
    public let deletedAt: String?

    public init(path: String, filename: String, libraryID: String, deletedAt: String? = nil) {
        self.path = path
        self.filename = filename
        self.libraryID = libraryID
        self.deletedAt = deletedAt
    }

    private enum CodingKeys: String, CodingKey {
        case path
        case filename
        case libraryID = "library_id"
        case deletedAt = "deleted_at"
    }
}

/// Resolve the absolute filesystem path for an asset's primary on-disk
/// location, composed from the library root plus the relative directory and
/// filename in `fileInfo[0]`. Mirrors `assetAbsPath` in
/// `src/api/src/indexer/images.repo.ts`.
///
/// Falls back to the legacy `absPath` field for unmigrated rows or when the
/// primary entry's `library_id` is not present in `libraries`. Returns `nil`
/// when neither source resolves (or when the legacy fallback is the empty
/// string — the server treats `""` as unresolvable).
public func assetAbsPath(
    fileInfo: [FileInfo]?,
    legacyAbsPath: String?,
    libraries: [String: String]
) -> String? {
    if let primary = (fileInfo ?? []).first(where: { $0.deletedAt == nil }) {
        if let root = libraries[primary.libraryID] {
            // `FileInfo.path` is POSIX-separated by contract. On macOS / iOS
            // (production targets) `/` is the platform separator, so a direct
            // join is correct; on other hosts we'd split + re-join via a
            // platform path API. Kept simple because Apple targets are POSIX.
            //
            // Normalise the root + path edges so a trailing `/` on `root`
            // (e.g. `"/Volumes/Photos/"`) or a stray leading/trailing `/`
            // on `primary.path` doesn't produce `//` in the joined string.
            // Preserve `root == "/"` as-is (root of the filesystem).
            let trimmedRoot = root == "/" ? "/" : trimTrailingSlashes(root)
            let dir = trimSlashes(primary.path)
            if dir.isEmpty {
                return trimmedRoot == "/"
                    ? "/\(primary.filename)"
                    : "\(trimmedRoot)/\(primary.filename)"
            }
            return trimmedRoot == "/"
                ? "/\(dir)/\(primary.filename)"
                : "\(trimmedRoot)/\(dir)/\(primary.filename)"
        }
    }
    if let legacy = legacyAbsPath, !legacy.isEmpty {
        return legacy
    }
    return nil
}

/// Strip trailing `/` characters. Returns `""` if the string is all slashes.
private func trimTrailingSlashes(_ s: String) -> String {
    var end = s.endIndex
    while end > s.startIndex {
        let prev = s.index(before: end)
        if s[prev] != "/" { break }
        end = prev
    }
    return String(s[s.startIndex..<end])
}

/// Strip leading and trailing `/` characters. Returns `""` if the string is
/// all slashes.
private func trimSlashes(_ s: String) -> String {
    var start = s.startIndex
    while start < s.endIndex && s[start] == "/" {
        start = s.index(after: start)
    }
    var end = s.endIndex
    while end > start {
        let prev = s.index(before: end)
        if s[prev] != "/" { break }
        end = prev
    }
    return String(s[start..<end])
}

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
    /// Path relative to the folder root (`folder.path`). Populated by
    /// the server's `recordAndPublishAssetChange` at write time (Phase
    /// 6 item 2). `nil` when the row pre-dates the change OR when the
    /// server couldn't reconcile the absPath against the named folder
    /// root (defensive — server logs a warn and stores null rather
    /// than emit a wrong path). Consumers MUST tolerate `nil` and fall
    /// back to the prior `.workingSet` routing in that case.
    public let relativePath: String?
    public let at: Date

    public init(cursor: Int64, assetID: String?, folderID: String?,
                kind: AssetChangeKind, absPath: String?,
                relativePath: String? = nil, at: Date) {
        self.cursor = cursor
        self.assetID = assetID
        self.folderID = folderID
        self.kind = kind
        self.absPath = absPath
        self.relativePath = relativePath
        self.at = at
    }

    private enum CodingKeys: String, CodingKey {
        case cursor, kind, at
        case assetID = "asset_id"
        case folderID = "folder_id"
        case absPath = "abs_path"
        case relativePath = "relative_path"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.cursor = try c.decode(Int64.self, forKey: .cursor)
        self.assetID = try c.decodeIfPresent(String.self, forKey: .assetID)
        self.folderID = try c.decodeIfPresent(String.self, forKey: .folderID)
        self.kind = try c.decode(AssetChangeKind.self, forKey: .kind)
        self.absPath = try c.decodeIfPresent(String.self, forKey: .absPath)
        // Tolerate both shapes: legacy rows omit the key entirely;
        // newer rows may carry an explicit null. `decodeIfPresent`
        // returns nil for either form.
        self.relativePath = try c.decodeIfPresent(String.self, forKey: .relativePath)
        self.at = try c.decode(Date.self, forKey: .at)
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
    /// Deprecated: prefer composing the path via
    /// `assetAbsPath(fileInfo:legacyAbsPath:libraries:)`. Retained on the
    /// wire during the content-addressing migration; drops once every
    /// server is on the new indexer.
    public let absPath: String
    /// Canonical on-disk locations. Optional during the additive phase of
    /// the content-addressing migration — pre-backfill rows from older
    /// servers may omit it; pass through `assetAbsPath` which falls back
    /// to `absPath`.
    public let fileInfo: [FileInfo]?
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
                fileInfo: [FileInfo]? = nil,
                mtime: Int64, rating: Int, hasXMP: Bool) {
        self.id = id
        self.folderID = folderID
        self.filename = filename
        self.absPath = absPath
        self.fileInfo = fileInfo
        self.mtime = mtime
        self.rating = rating
        self.hasXMP = hasXMP
    }

    private enum CodingKeys: String, CodingKey {
        case id, filename, mtime, rating
        case folderID = "folder_id"
        case absPath = "abs_path"
        case fileInfo = "fileinfo"
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
    /// Deprecated: prefer composing the path via
    /// `assetAbsPath(fileInfo:legacyAbsPath:libraries:)`. Retained on the
    /// wire during the content-addressing migration; drops once every
    /// server is on the new indexer.
    public let absPath: String
    /// Canonical on-disk locations. Optional during the additive phase of
    /// the content-addressing migration — pre-backfill rows from older
    /// servers may omit it; pass through `assetAbsPath` which falls back
    /// to `absPath`.
    public let fileInfo: [FileInfo]?
    public let size: Int64
    /// Epoch MILLISECONDS. Server emits `stat.mtimeMs` which is a
    /// floating-point number (sub-millisecond precision); decode as
    /// `Double` so the JSON parser doesn't reject the fractional part.
    public let mtimeMS: Double
    public let rating: Int

    public init(id: String, folderID: String, filename: String, absPath: String,
                fileInfo: [FileInfo]? = nil,
                size: Int64, mtimeMS: Double, rating: Int) {
        self.id = id
        self.folderID = folderID
        self.filename = filename
        self.absPath = absPath
        self.fileInfo = fileInfo
        self.size = size
        self.mtimeMS = mtimeMS
        self.rating = rating
    }

    /// Convenience: the modification date as a Foundation `Date`,
    /// computed from the server's millisecond timestamp.
    public var contentModificationDate: Date {
        Date(timeIntervalSince1970: mtimeMS / 1000.0)
    }

    private enum CodingKeys: String, CodingKey {
        case id, filename, rating, size
        case folderID = "folder_id"
        case absPath = "abs_path"
        case fileInfo = "fileinfo"
        case mtimeMS = "mtime"
    }
}
