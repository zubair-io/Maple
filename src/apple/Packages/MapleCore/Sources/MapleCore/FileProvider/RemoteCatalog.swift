// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift
import Foundation
import OSLog

public struct LibraryRoot: Codable, Equatable, Sendable {
    public let id: String
    public let path: String         // absolute path on the server's filesystem
    public let label: String
    public let fileCount: Int

    enum CodingKeys: String, CodingKey {
        case id, path, label
        case fileCount = "file_count"
    }
}

public struct DirChild: Codable, Equatable, Sendable {
    public let name: String
    public let path: String         // absolute, server-side
    public let mtime: Date          // ISO-8601

    public init(name: String, path: String, mtime: Date) {
        self.name = name
        self.path = path
        self.mtime = mtime
    }
}

public struct ImageChild: Codable, Equatable, Sendable {
    public let name: String
    public let path: String
    public let mtime: Date
    public let size: Int64
    public let ext: String
    public let assetID: String?     // server-side Mongo ObjectId; nil if not yet indexed

    public init(name: String, path: String, mtime: Date, size: Int64, ext: String, assetID: String?) {
        self.name = name
        self.path = path
        self.mtime = mtime
        self.size = size
        self.ext = ext
        self.assetID = assetID
    }

    enum CodingKeys: String, CodingKey {
        case name, path, mtime, size, ext
        case assetID = "id"
    }
}

public struct SidecarChild: Codable, Equatable, Sendable {
    public let name: String
    public let path: String
    public let mtime: Date
    public let size: Int64
    public let assetID: String

    public init(name: String, path: String, mtime: Date, size: Int64, assetID: String) {
        self.name = name
        self.path = path
        self.mtime = mtime
        self.size = size
        self.assetID = assetID
    }

    enum CodingKeys: String, CodingKey {
        case name, path, mtime, size
        case assetID = "asset_id"
    }
}

/// A regular file that is neither an indexed image nor an `.xmp` sidecar
/// (video, documents, extensionless files). Stored + synced but has no
/// `AssetDoc`, so it carries no asset id — it's addressed by its path.
public struct FileChild: Codable, Equatable, Sendable {
    public let name: String
    public let path: String
    public let mtime: Date
    public let size: Int64
    public let ext: String          // lowercase, no dot; "" for extensionless files

    public init(name: String, path: String, mtime: Date, size: Int64, ext: String) {
        self.name = name
        self.path = path
        self.mtime = mtime
        self.size = size
        self.ext = ext
    }
}

public struct DirContents: Codable, Equatable, Sendable {
    public let path: String
    public let parent: String?
    public let dirs: [DirChild]
    public let images: [ImageChild]
    public let sidecars: [SidecarChild]
    /// Non-image, non-sidecar regular files. Surfaced so the File Provider
    /// can sync every file type; these never carry an asset id.
    public let files: [FileChild]
    /// Opaque continuation token from the server. Present when paged mode
    /// is engaged and more entries remain; nil otherwise. Clients
    /// round-trip the string verbatim to fetch the next page.
    public let nextCursor: String?

    public init(path: String, parent: String?, dirs: [DirChild], images: [ImageChild],
                sidecars: [SidecarChild], files: [FileChild] = [], nextCursor: String? = nil) {
        self.path = path
        self.parent = parent
        self.dirs = dirs
        self.images = images
        self.sidecars = sidecars
        self.files = files
        self.nextCursor = nextCursor
    }

    private enum CodingKeys: String, CodingKey {
        case path, parent, dirs, images, sidecars, files
        case nextCursor = "next_cursor"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.path = try c.decode(String.self, forKey: .path)
        self.parent = try c.decodeIfPresent(String.self, forKey: .parent)
        self.dirs = try c.decode([DirChild].self, forKey: .dirs)
        self.images = try c.decode([ImageChild].self, forKey: .images)
        // Tolerate the field being absent — pre-Phase-2 servers don't send it.
        self.sidecars = (try? c.decode([SidecarChild].self, forKey: .sidecars)) ?? []
        // Tolerate absence — servers without the sync-all-files change omit it.
        self.files = (try? c.decode([FileChild].self, forKey: .files)) ?? []
        self.nextCursor = try c.decodeIfPresent(String.self, forKey: .nextCursor)
    }
}

public struct UploadResponse: Codable, Equatable, Sendable {
    /// nil when the uploaded file is not an indexed image — the server
    /// stored the bytes but created no `AssetDoc`, so there's no asset id.
    public let assetID: String?
    public let absPath: String
    public let size: Int64
    public let mtime: Date

    public init(assetID: String?, absPath: String, size: Int64, mtime: Date) {
        self.assetID = assetID
        self.absPath = absPath
        self.size = size
        self.mtime = mtime
    }

    enum CodingKeys: String, CodingKey {
        case absPath = "abs_path"
        case size, mtime
        case assetID = "asset_id"
    }
}

public struct TrashItem: Codable, Equatable, Sendable {
    public let assetID: String
    public let filename: String
    public let originalRelativePath: String
    public let trashRelativePath: String
    public let size: Int64
    public let mtime: Date
    public let deletedAt: Date

    public init(assetID: String, filename: String, originalRelativePath: String, trashRelativePath: String, size: Int64, mtime: Date, deletedAt: Date) {
        self.assetID = assetID
        self.filename = filename
        self.originalRelativePath = originalRelativePath
        self.trashRelativePath = trashRelativePath
        self.size = size
        self.mtime = mtime
        self.deletedAt = deletedAt
    }

    enum CodingKeys: String, CodingKey {
        case filename, size, mtime
        case assetID = "asset_id"
        case originalRelativePath = "original_relative_path"
        case trashRelativePath = "trash_relative_path"
        case deletedAt = "deleted_at"
    }
}

public struct TrashListResponse: Codable, Equatable, Sendable {
    public let items: [TrashItem]
    public let nextCursor: String?

    public init(items: [TrashItem], nextCursor: String?) {
        self.items = items
        self.nextCursor = nextCursor
    }

    enum CodingKeys: String, CodingKey {
        case items
        case nextCursor = "next_cursor"
    }
}

public struct RestoreResponse: Codable, Equatable, Sendable {
    public let assetID: String
    public let absPath: String       // server-side path; do NOT stat on the Mac
    public let filename: String
    public let size: Int64
    public let mtime: Date

    public init(assetID: String, absPath: String, filename: String, size: Int64, mtime: Date) {
        self.assetID = assetID
        self.absPath = absPath
        self.filename = filename
        self.size = size
        self.mtime = mtime
    }

    enum CodingKeys: String, CodingKey {
        case assetID = "asset_id"
        case absPath = "abs_path"
        case filename, size, mtime
    }
}

public enum UploadOutcome: Equatable, Sendable {
    case ok(UploadResponse)
    case unsupported
}

public struct MakeDirResponse: Codable, Equatable, Sendable {
    public let absPath: String

    public init(absPath: String) {
        self.absPath = absPath
    }

    enum CodingKeys: String, CodingKey {
        case absPath = "abs_path"
    }
}

/// Outcome of `RemoteCatalog.moveFolder`. Domain-neutral so the HTTP
/// layer stays free of FileProvider types — the extension maps
/// `.conflict` to `NSFileProviderError.filenameCollision`.
public enum MoveFolderResult: Equatable, Sendable {
    case ok(MakeDirResponse)
    /// 409 — a directory already exists at the target path.
    case conflict
}

public enum XMPWriteResult: Equatable, Sendable {
    /// Write succeeded; the response's Last-Modified header is parsed
    /// into this Date and reflects the new on-disk mtime.
    case ok(mtime: Date)
    /// Server detected a precondition mismatch and wrote the bytes to a
    /// conflict-copy file instead. The original sidecar is untouched.
    case conflict(path: String, mtime: Date)
}

/// Thrown by `RemoteCatalog` when an asset ID fails shape validation
/// before any URL is built. The shape is the 24-hex-char Mongo ObjectID
/// produced by the API at `src/api/src/routes/assets.ts` (`new ObjectId(params.id)`).
/// Anything else is either a programming error or a path-traversal
/// attempt; in either case we refuse to interpolate it into the URL.
public struct InvalidAssetIDError: Error, Equatable, Sendable {
    public let assetID: String
    public init(assetID: String) { self.assetID = assetID }
}

public actor RemoteCatalog {
    internal let http: AuthenticatedHTTPClient
    /// The address used to build every request URL below. Starts as the
    /// identity URL the extension was configured with; `updateServer(_:)`
    /// swaps it to the server's LAN address once
    /// `FileProviderExtensionCore.init` resolves one, so subsequent
    /// requests (folders/thumbs/downloads/xmp/uploads) go over the LAN when
    /// the host device is on the same network as the server. `http`'s own
    /// (private, separately-held) server field is untouched — it only
    /// builds the token-refresh request and stays on the identity URL.
    internal var server: URL
    private let log = Logger(subsystem: "app.justmaple.aperture.fileprovider", category: "catalog")
    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        // `Date.toISOString()` (the server's emitter) always includes
        // fractional seconds (`2026-05-15T10:00:00.123Z`), but
        // `.iso8601` does NOT parse them — every trash/upload/restore
        // decode would fail. Try fractional first, then plain.
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        d.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            if let date = withFractional.date(from: raw) { return date }
            if let date = plain.date(from: raw) { return date }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid ISO-8601 date: \(raw)",
            )
        }
        return d
    }()

    /// In-memory cache of `(etag, decoded value)` keyed by absolute URL.
    /// One entry per URL — sufficient for `/api/folders` (one URL),
    /// `/api/fs/dir?path=…` (one URL per directory the user touches),
    /// and `/api/assets/<id>/thumb` (one URL per asset).
    ///
    /// Bounded LRU: insertions beyond `etagCacheCap` evict the least-
    /// recently-used entry. Without the bound, a Finder spacebar-walk
    /// through a 10k-asset folder pins ~1 GB of `Data` in the extension
    /// (Phase 5c perf audit, Phase 6 item 1).
    ///
    /// The payload is stored as `Any` because the three call sites
    /// produce different concrete types (`[LibraryRoot]`, `DirContents`,
    /// `Data`). All access happens inside the actor, so the value-level
    /// `Sendable` story is safe — the dictionary itself is actor-isolated.
    ///
    /// Implementation: an order-array (LRU at index 0, MRU at end) +
    /// a dict for O(1) lookup. The order array stays tiny (≤ cap) so the
    /// linear `firstIndex(of:)` on touch is cheap in practice — 256
    /// pointer compares per slider tick is dwarfed by the network call
    /// the cache exists to avoid.
    private var etagCache: [String: ETagEntry] = [:]
    private var etagOrder: [String] = []

    /// Maximum number of entries the ETag cache holds. 256 is well above
    /// any realistic single-session enumeration (a typical Finder window
    /// touches one folder and ≤ a few hundred thumbs at a time) and
    /// caps memory at a few hundred MB worst-case (thumbs are the
    /// largest payload). Revisit if profiling shows the working-set
    /// straddles this number.
    public static let etagCacheCap: Int = 256

    /// Test-only accessor: current number of entries in the ETag cache.
    /// Lets `RemoteCatalogETagTests` assert the bound holds under load
    /// without poking at private state via `@testable` reflection.
    internal var _etagCacheCountForTesting: Int { etagCache.count }

    private struct ETagEntry {
        let etag: String
        let payload: Any
    }

    /// Look up an entry and promote it to MRU on hit. Returns the entry
    /// or nil if absent.
    private func etagCacheGet(_ key: String) -> ETagEntry? {
        guard let entry = etagCache[key] else { return nil }
        etagOrderTouch(key)
        return entry
    }

    /// Insert or refresh an entry. New keys are appended; existing keys
    /// have their payload replaced and are promoted to MRU. When inserting
    /// a new key past the cap, the LRU key is evicted first.
    private func etagCacheSet(_ key: String, _ entry: ETagEntry) {
        if etagCache[key] != nil {
            etagCache[key] = entry
            etagOrderTouch(key)
            return
        }
        if etagCache.count >= Self.etagCacheCap, let lru = etagOrder.first {
            etagOrder.removeFirst()
            etagCache.removeValue(forKey: lru)
        }
        etagCache[key] = entry
        etagOrder.append(key)
    }

    /// Move `key` to the MRU end of `etagOrder`. Caller has already
    /// confirmed the key exists.
    private func etagOrderTouch(_ key: String) {
        if let idx = etagOrder.firstIndex(of: key) {
            etagOrder.remove(at: idx)
        }
        etagOrder.append(key)
    }

    private let downloadURLSession: URLSession

    public init(http: AuthenticatedHTTPClient, server: URL,
                downloadURLSession: URLSession? = nil) {
        self.http = http
        self.server = server
        // Default download session uses `.ephemeral` so RAW asset bodies are
        // never persisted to URLCache, cookie storage, or credential storage:
        // the OS-side File Provider cache is the canonical store and the
        // bodies are large (100 MP RAW ≈ 150 MB) — sharing them with
        // `URLSession.shared.configuration.urlCache` would both waste disk
        // and cross-contaminate caching state with the main app. Tests
        // inject a session whose protocolClasses include StubURLProtocol.
        if let injected = downloadURLSession {
            self.downloadURLSession = injected
        } else {
            let cfg = URLSessionConfiguration.ephemeral
            // `.ephemeral` already nils urlCache/cookies/credentials; the
            // assignments below are belt-and-suspenders + intent-as-doc.
            cfg.urlCache = nil
            cfg.httpCookieStorage = nil
            cfg.urlCredentialStorage = nil
            self.downloadURLSession = URLSession(configuration: cfg)
        }
    }

    /// Swaps the address used for future requests — see the `server` doc
    /// comment above. Actor-isolated, so this can't race an in-flight
    /// request reading the old value mid-build.
    public func updateServer(_ url: URL) {
        self.server = url
    }

    /// Test-only accessor: the URLSession used for streaming asset bodies.
    /// Exposed so the Issue #3 regression test can assert the ephemeral
    /// configuration. Not part of the public contract; use only from
    /// `@testable import MapleCore`. `nonisolated` because the underlying
    /// `let` is set during init and never mutated.
    internal nonisolated var _downloadURLSessionForTesting: URLSession { downloadURLSession }

    /// Drop the entire ETag cache. Called by the FP extension's
    /// ChangeFeedClient on a 409 stale-cursor reply — the cursor reset
    /// implies the cache's entries reflect pre-gap state and a 304
    /// against them would serve a stale folder/dir list.
    public func invalidateETagCache() {
        etagCache.removeAll()
        etagOrder.removeAll()
    }

    /// Generic helper: send `If-None-Match` when we have a cached entry,
    /// return cached value on 304, decode + store on 200. Used by every
    /// JSON-bodied catalog call that participates in revalidation.
    private func fetchCachedJSON<T: Decodable & Sendable>(
        url: URL,
        decode: T.Type,
    ) async throws -> T {
        var req = URLRequest(url: url)
        let key = url.absoluteString
        let cached = etagCacheGet(key)
        if let cached {
            req.setValue(cached.etag, forHTTPHeaderField: "If-None-Match")
        }
        let (data, resp) = try await http.data(for: req)
        let httpResp = resp as? HTTPURLResponse
        if httpResp?.statusCode == 304,
           let cached,
           let value = cached.payload as? T {
            return value
        }
        try Self.check2xx(resp)
        let value = try decoder.decode(T.self, from: data)
        if let etag = httpResp?.value(forHTTPHeaderField: "ETag") {
            etagCacheSet(key, ETagEntry(etag: etag, payload: value))
        }
        return value
    }

    public func listFolders() async throws -> [LibraryRoot] {
        let url = server.appending(path: "/api/folders")
        log.notice("listFolders GET \(url.absoluteString, privacy: .public)")
        do {
            let result = try await fetchCachedJSON(url: url, decode: [LibraryRoot].self)
            log.notice("listFolders ok count=\(result.count, privacy: .public)")
            return result
        } catch {
            log.error("listFolders FAILED: \(String(describing: error), privacy: .public)")
            throw error
        }
    }

    public func listDir(absolutePath: String,
                        cursor: String? = nil,
                        limit: Int? = nil) async throws -> DirContents {
        var comps = URLComponents(url: server.appending(path: "/api/fs/dir"), resolvingAgainstBaseURL: false)!
        var q: [URLQueryItem] = [.init(name: "path", value: absolutePath)]
        if let cursor { q.append(.init(name: "cursor", value: cursor)) }
        if let limit { q.append(.init(name: "limit", value: String(limit))) }
        comps.queryItems = q
        // The ETag cache keys on the full URL, so each (path, cursor,
        // limit) combination gets its own cached entry. Phase 5c's
        // server-side ETag is body-hash, so paged responses round-trip
        // correctly through the same revalidation path.
        return try await fetchCachedJSON(url: comps.url!, decode: DirContents.self)
    }

    /// Streams the asset body to `localURL` via `URLSession.download(for:)`.
    /// Peak memory stays at the URLSession download buffer (single-digit MB)
    /// instead of the full asset body (~150 MB for a 100 MP RAW). The HTTP
    /// Auth header is injected inside `AuthenticatedHTTPClient
    /// .refreshIfNeededAndRetry`, which also handles single-flight 401
    /// refresh + one retry.
    public func downloadAsset(assetID: String, to localURL: URL) async throws {
        try Self.validateAssetID(assetID)
        let req = URLRequest(url: server.appending(path: "/api/assets/\(assetID)/raw"))
        let session = downloadURLSession
        let (tmpURL, resp) = try await http.refreshIfNeededAndRetry(request: req) { injected in
            try await session.download(for: injected)
        }
        try Self.check2xx(resp)
        // download() returns a tmp URL inside NSTemporaryDirectory; move it
        // into place. The destination's parent directory must exist — the
        // File Provider extension hands us a tmp dir from
        // NSFileProviderManager.temporaryDirectoryURL().
        let fm = FileManager.default
        if fm.fileExists(atPath: localURL.path) {
            try fm.removeItem(at: localURL)
        }
        try fm.moveItem(at: tmpURL, to: localURL)
    }

    internal static func check2xx(_ resp: URLResponse) throws {
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(code) else { throw URLError(.badServerResponse) }
    }

    /// Validates that `assetID` is a 24-character hex Mongo ObjectID.
    /// Anything else cannot reach the server safely — the value is
    /// interpolated into a URL path segment, and a string containing
    /// `..`, `/`, or `%2F` would let an attacker pivot to other routes.
    /// The API itself parses `new ObjectId(params.id)` (see
    /// `src/api/src/routes/assets.ts`) so non-ObjectID input always 4xx's
    /// server-side — guarding here means we never even open the socket.
    static func validateAssetID(_ assetID: String) throws {
        guard assetID.count == 24 else {
            throw InvalidAssetIDError(assetID: assetID)
        }
        for scalar in assetID.unicodeScalars {
            let v = scalar.value
            let isDigit  = (0x30...0x39).contains(v)
            let isLower  = (0x61...0x66).contains(v)  // a-f
            let isUpper  = (0x41...0x46).contains(v)  // A-F
            guard isDigit || isLower || isUpper else {
                throw InvalidAssetIDError(assetID: assetID)
            }
        }
    }

    /// GET /api/assets/<assetID>/thumb. Returns the JPEG bytes of the
    /// pre-baked preview. Throws on non-2xx — 404 in particular means
    /// "thumbnail not generated yet" and the Quick Look extension
    /// uses that signal to fall back to OS-default RAW materialization.
    ///
    /// Participates in the same per-URL ETag cache as the JSON
    /// enumeration calls: a 304 reply returns the in-memory `Data` from
    /// the prior 200. The cache is bounded LRU (cap: `etagCacheCap`) —
    /// a spacebar-walk across thousands of assets evicts older thumb
    /// payloads instead of pinning them all.
    public func getThumb(assetID: String) async throws -> Data {
        try Self.validateAssetID(assetID)
        let url = server.appending(path: "/api/assets/\(assetID)/thumb")
        var req = URLRequest(url: url)
        let key = url.absoluteString
        let cached = etagCacheGet(key)
        if let cached {
            req.setValue(cached.etag, forHTTPHeaderField: "If-None-Match")
        }
        let (data, resp) = try await http.data(for: req)
        let httpResp = resp as? HTTPURLResponse
        if httpResp?.statusCode == 304,
           let cached,
           let bytes = cached.payload as? Data {
            return bytes
        }
        try Self.check2xx(resp)
        if let etag = httpResp?.value(forHTTPHeaderField: "ETag") {
            etagCacheSet(key, ETagEntry(etag: etag, payload: data))
        }
        return data
    }

    /// Thumb fetch result used by `getThumbConditional`. `notModified`
    /// happens when the server returned 304 to an `If-None-Match` —
    /// callers reuse their own cached bytes. `ok` carries the 200 body
    /// plus the new ETag (nil if the server didn't send one).
    public enum ThumbFetchResult: Sendable, Equatable {
        case ok(data: Data, etag: String?)
        case notModified
    }

    /// GET /api/assets/<assetID>/thumb with an explicit `If-None-Match`
    /// header and a structured result that exposes the response ETag.
    ///
    /// Sibling to `getThumb(assetID:)` — `getThumb` participates in the
    /// in-process LRU ETag cache, which is the right behaviour for the
    /// host app (long-lived process, ETag cache amortises across requests).
    /// The QL extension is short-lived per launch, so it disk-caches the
    /// bytes itself via `QuickLookThumbDiskCache` and needs the raw
    /// ETag back to key the file. This method intentionally bypasses
    /// `etagCache` to keep both roles independent — the disk cache is
    /// the only thumb cache that survives the extension's lifetime.
    ///
    /// 404 still throws (URLError) — caller falls back to the OS-default
    /// preview path, same as `getThumb`.
    public func getThumbConditional(
        assetID: String,
        ifNoneMatch: String?
    ) async throws -> ThumbFetchResult {
        try Self.validateAssetID(assetID)
        let url = server.appending(path: "/api/assets/\(assetID)/thumb")
        var req = URLRequest(url: url)
        if let etag = ifNoneMatch {
            req.setValue(etag, forHTTPHeaderField: "If-None-Match")
        }
        let (data, resp) = try await http.data(for: req)
        let httpResp = resp as? HTTPURLResponse
        if httpResp?.statusCode == 304 {
            return .notModified
        }
        try Self.check2xx(resp)
        let newETag = httpResp?.value(forHTTPHeaderField: "ETag")
        return .ok(data: data, etag: newETag)
    }

    /// GET /api/assets/<assetID>/xmp[?conflict=<basename>]. Returns the
    /// raw XMP bytes. For conflict copies, `conflictBasename` must match
    /// the server's pairing rule (canonical base + " (conflict from …)"
    /// suffix, optionally with " (N)").
    public func getXMP(assetID: String, conflictBasename: String?) async throws -> Data {
        try Self.validateAssetID(assetID)
        var comps = URLComponents(
            url: server.appending(path: "/api/assets/\(assetID)/xmp"),
            resolvingAgainstBaseURL: false,
        )!
        if let conflictBasename {
            comps.queryItems = [.init(name: "conflict", value: conflictBasename)]
        }
        let req = URLRequest(url: comps.url!)
        let (data, resp) = try await http.data(for: req)
        try Self.check2xx(resp)
        return data
    }

    /// PUT /api/assets/<assetID>/xmp.
    ///
    /// - `conflictBasename`: when non-nil, addresses a specific conflict
    ///   copy via `?conflict=<basename>`. Unconditional write — the
    ///   `ifMtimeMatches` precondition is ignored in this mode because
    ///   the caller is editing this exact file directly.
    /// - `ifMtimeMatches`: only used when `conflictBasename == nil`.
    ///   nil = unconditional create; otherwise precondition.
    /// - `deviceName`: stamped into conflict-copy filenames the server
    ///   may create on precondition mismatch (canonical-write mode only).
    public func putXMP(
        assetID: String,
        data: Data,
        ifMtimeMatches: Date?,
        deviceName: String,
        conflictBasename: String? = nil
    ) async throws -> XMPWriteResult {
        try Self.validateAssetID(assetID)
        var comps = URLComponents(
            url: server.appending(path: "/api/assets/\(assetID)/xmp"),
            resolvingAgainstBaseURL: false,
        )!
        if let conflictBasename {
            comps.queryItems = [.init(name: "conflict", value: conflictBasename)]
        }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "PUT"
        req.setValue("text/plain; charset=utf-8", forHTTPHeaderField: "Content-Type")
        req.setValue(deviceName, forHTTPHeaderField: "X-Maple-Device-Name")
        // Precondition only applies to the canonical write path.
        if conflictBasename == nil, let prior = ifMtimeMatches {
            req.setValue(String(Int(prior.timeIntervalSince1970)), forHTTPHeaderField: "X-If-Mtime-Matches")
        }
        req.httpBody = data
        let (respData, resp) = try await http.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if status == 204 {
            let mtime = Self.parseLastModified(resp as? HTTPURLResponse) ?? Date()
            return .ok(mtime: mtime)
        }
        if status == 409 {
            struct Body: Decodable { let conflict_path: String; let conflict_mtime: String }
            let body = try decoder.decode(Body.self, from: respData)
            let iso = ISO8601DateFormatter()
            iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let mtime = iso.date(from: body.conflict_mtime)
                ?? ISO8601DateFormatter().date(from: body.conflict_mtime)
                ?? Date()
            return .conflict(path: body.conflict_path, mtime: mtime)
        }
        throw URLError(.badServerResponse)
    }

    /// DELETE /api/assets/<assetID>/xmp[?conflict=<basename>]. Idempotent.
    public func deleteXMP(assetID: String, conflictBasename: String? = nil) async throws {
        try Self.validateAssetID(assetID)
        var comps = URLComponents(
            url: server.appending(path: "/api/assets/\(assetID)/xmp"),
            resolvingAgainstBaseURL: false,
        )!
        if let conflictBasename {
            comps.queryItems = [.init(name: "conflict", value: conflictBasename)]
        }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "DELETE"
        let (_, resp) = try await http.data(for: req)
        try Self.check2xx(resp)
    }

    private static func parseLastModified(_ resp: HTTPURLResponse?) -> Date? {
        guard let raw = resp?.value(forHTTPHeaderField: "Last-Modified") else { return nil }
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.timeZone = TimeZone(identifier: "GMT")
        fmt.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return fmt.date(from: raw)
    }

    /// Percent-encode a relative path for the `X-Maple-Target-Path`
    /// header. `.urlPathAllowed` keeps `/` (we want directory
    /// separators preserved) but encodes spaces, non-ASCII, and `%`
    /// itself so server-side `decodeURIComponent` round-trips
    /// cleanly. Throws rather than silently sending unencoded data on
    /// the (extremely rare) failure path — the server would reject
    /// malformed input with a 400 and the caller has no way to
    /// recover.
    static func encodeTargetPath(_ path: String) throws -> String {
        guard let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else {
            throw URLError(.badURL)
        }
        return encoded
    }

    // MARK: - Phase 3: uploads + trash + restore

    /// Upload a file to the given folder. Streams `fileURL` via
    /// `URLSession.upload(for:fromFile:)`. Returns `.ok` on 201,
    /// `.unsupported` on 415; throws on anything else. A duplicate upload
    /// (file already at the target path) is handled server-side by
    /// moving the prior file to trash and returning 201, so the client
    /// never sees a conflict status.
    public func uploadFile(
        folderID: String,
        targetRelativePath: String,
        fileURL: URL,
        mtime: Date?
    ) async throws -> UploadOutcome {
        var req = URLRequest(url: server.appending(path: "/api/folders/\(folderID)/upload"))
        req.httpMethod = "POST"
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.setValue(try Self.encodeTargetPath(targetRelativePath), forHTTPHeaderField: "X-Maple-Target-Path")
        if let mtime {
            req.setValue(String(Int(mtime.timeIntervalSince1970)), forHTTPHeaderField: "X-Maple-File-Mtime")
        }
        let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        // `NSNumber.intValue` is a 32-bit conversion — files larger than
        // 2 GB (RAW/TIFF can hit this) would overflow before being sent
        // as Content-Length. Use the 64-bit accessor instead.
        let size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
        req.setValue(String(size), forHTTPHeaderField: "Content-Length")
        let (data, resp) = try await http.upload(for: req, fromFile: fileURL)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if status == 201 {
            return .ok(try decoder.decode(UploadResponse.self, from: data))
        }
        if status == 415 { return .unsupported }
        throw URLError(.badServerResponse)
    }

    /// Stream a non-indexed file's bytes to `localURL` by its library-relative
    /// path. Non-image files have no `AssetDoc`, so `downloadAsset` can't
    /// reach them — this hits `GET /api/folders/<id>/file?path=<rel>` instead.
    /// Mirrors `downloadAsset`'s streaming + atomic-move behaviour.
    public func downloadFile(folderID: String, relativePath: String, to localURL: URL) async throws {
        var comps = URLComponents(
            url: server.appending(path: "/api/folders/\(folderID)/file"),
            resolvingAgainstBaseURL: false)!
        comps.queryItems = [.init(name: "path", value: relativePath)]
        let req = URLRequest(url: comps.url!)
        let session = downloadURLSession
        let (tmpURL, resp) = try await http.refreshIfNeededAndRetry(request: req) { injected in
            try await session.download(for: injected)
        }
        try Self.check2xx(resp)
        let fm = FileManager.default
        if fm.fileExists(atPath: localURL.path) {
            try fm.removeItem(at: localURL)
        }
        try fm.moveItem(at: tmpURL, to: localURL)
    }

    /// Stat a non-indexed file by its library-relative path. Lets `item(for:)`
    /// resolve a bare `.file(folderID:relativePath:)` identifier (size + mtime)
    /// without downloading the bytes. The `/file-meta` response shape matches
    /// `FileChild` exactly, so we decode straight into it.
    ///
    /// Returns nil on 404 (file gone) so the caller can map to `noSuchItem`
    /// while still propagating transient failures (network/auth/5xx) — mirrors
    /// `getAsset`, and lets the OS tell "evict this item" apart from "retry".
    public func statFile(folderID: String, relativePath: String) async throws -> FileChild? {
        var comps = URLComponents(
            url: server.appending(path: "/api/folders/\(folderID)/file-meta"),
            resolvingAgainstBaseURL: false)!
        comps.queryItems = [.init(name: "path", value: relativePath)]
        let req = URLRequest(url: comps.url!)
        let (data, resp) = try await http.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if code == 404 { return nil }
        try Self.check2xx(resp)
        return try decoder.decode(FileChild.self, from: data)
    }

    /// Create a subdirectory under a library root. `targetRelativePath`
    /// is sent percent-encoded in the `X-Maple-Target-Path` header and
    /// validated server-side the same way uploads are (no leading `/`,
    /// no `..`/`.` components, no leading-dot segments). Idempotent —
    /// `mkdir -p` doesn't error if the directory already exists.
    ///
    /// Called from the File Provider extension when the OS asks to
    /// create a folder (Finder "New Folder", or the folder-create that
    /// precedes a drag-in of a folder full of files).
    public func makeDir(
        folderID: String,
        targetRelativePath: String
    ) async throws -> MakeDirResponse {
        var req = URLRequest(url: server.appending(path: "/api/folders/\(folderID)/mkdir"))
        req.httpMethod = "POST"
        req.setValue(try Self.encodeTargetPath(targetRelativePath), forHTTPHeaderField: "X-Maple-Target-Path")
        let (data, resp) = try await http.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
        guard status == 201 else { throw URLError(.badServerResponse) }
        return try decoder.decode(MakeDirResponse.self, from: data)
    }

    /// Rename or move a subdirectory within a library root.
    /// `sourceRelativePath` is the folder's current path; `targetRelativePath`
    /// its new path. Both are sent percent-encoded (source in
    /// `X-Maple-Source-Path`, target in `X-Maple-Target-Path`) and
    /// validated server-side the same way uploads and `mkdir` are. The
    /// server `fs.rename`s the whole directory and lets its discover
    /// watcher reconcile the indexed asset paths.
    ///
    /// Called from the File Provider extension when the OS renames or
    /// moves a folder (`modifyItem` with `.filename` / `.parentItemIdentifier`).
    /// A 409 surfaces as `.conflict` (a directory already exists at the
    /// target) so the caller can map it to a filename collision — this
    /// layer stays free of FileProvider types.
    public func moveFolder(
        folderID: String,
        sourceRelativePath: String,
        targetRelativePath: String
    ) async throws -> MoveFolderResult {
        var req = URLRequest(url: server.appending(path: "/api/folders/\(folderID)/move"))
        req.httpMethod = "POST"
        req.setValue(try Self.encodeTargetPath(sourceRelativePath), forHTTPHeaderField: "X-Maple-Source-Path")
        req.setValue(try Self.encodeTargetPath(targetRelativePath), forHTTPHeaderField: "X-Maple-Target-Path")
        let (data, resp) = try await http.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
        if status == 409 { return .conflict }
        guard status == 200 else { throw URLError(.badServerResponse) }
        return .ok(try decoder.decode(MakeDirResponse.self, from: data))
    }

    /// DELETE /api/assets/<id>. 204 = success; everything else throws.
    /// Server distinguishes trash-vs-permanent-purge from the current
    /// asset state — both code paths return 204.
    public func deleteAsset(assetID: String) async throws {
        var req = URLRequest(url: server.appending(path: "/api/assets/\(assetID)"))
        req.httpMethod = "DELETE"
        let (_, resp) = try await http.data(for: req)
        try Self.check2xx(resp)
    }

    /// POST /api/assets/<id>/restore. `targetRelativePath` is sent in the
    /// body when non-nil; server defaults to `original_path` otherwise.
    /// `targetFolderID` is the new parent's library folder ID — the server
    /// uses it to reject cross-library restores (Phase 3 only restores
    /// into the asset's own library). Server appends `.restored[.N]` on
    /// collision; the new path comes back in `RestoreResponse.absPath`.
    public func restoreAsset(
        assetID: String,
        targetRelativePath: String?,
        targetFolderID: String? = nil,
    ) async throws -> RestoreResponse {
        var req = URLRequest(url: server.appending(path: "/api/assets/\(assetID)/restore"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: String] = [:]
        if let targetRelativePath { body["target_relative_path"] = targetRelativePath }
        if let targetFolderID { body["target_folder_id"] = targetFolderID }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await http.data(for: req)
        try Self.check2xx(resp)
        return try decoder.decode(RestoreResponse.self, from: data)
    }

    /// GET /api/folders/<id>/trash. `cursor` and `limit` are optional.
    public func listTrash(folderID: String, limit: Int? = nil, cursor: String? = nil) async throws -> TrashListResponse {
        var comps = URLComponents(
            url: server.appending(path: "/api/folders/\(folderID)/trash"),
            resolvingAgainstBaseURL: false,
        )!
        var qi: [URLQueryItem] = []
        if let limit { qi.append(.init(name: "limit", value: String(limit))) }
        if let cursor { qi.append(.init(name: "cursor", value: cursor)) }
        if !qi.isEmpty { comps.queryItems = qi }
        let req = URLRequest(url: comps.url!)
        let (data, resp) = try await http.data(for: req)
        try Self.check2xx(resp)
        return try decoder.decode(TrashListResponse.self, from: data)
    }
}
