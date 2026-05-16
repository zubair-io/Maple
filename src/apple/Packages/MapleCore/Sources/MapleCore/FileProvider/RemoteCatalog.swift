// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/RemoteCatalog.swift
import Foundation

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

public struct DirContents: Codable, Equatable, Sendable {
    public let path: String
    public let parent: String?
    public let dirs: [DirChild]
    public let images: [ImageChild]
    public let sidecars: [SidecarChild]

    public init(path: String, parent: String?, dirs: [DirChild], images: [ImageChild], sidecars: [SidecarChild]) {
        self.path = path
        self.parent = parent
        self.dirs = dirs
        self.images = images
        self.sidecars = sidecars
    }

    private enum CodingKeys: String, CodingKey { case path, parent, dirs, images, sidecars }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.path = try c.decode(String.self, forKey: .path)
        self.parent = try c.decodeIfPresent(String.self, forKey: .parent)
        self.dirs = try c.decode([DirChild].self, forKey: .dirs)
        self.images = try c.decode([ImageChild].self, forKey: .images)
        // Tolerate the field being absent — pre-Phase-2 servers don't send it.
        self.sidecars = (try? c.decode([SidecarChild].self, forKey: .sidecars)) ?? []
    }
}

public struct UploadResponse: Codable, Equatable, Sendable {
    public let assetID: String
    public let absPath: String
    public let size: Int64
    public let mtime: Date

    public init(assetID: String, absPath: String, size: Int64, mtime: Date) {
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
    case conflict
    case unsupported
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
    internal let server: URL
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
    /// The payload is stored as `Any` because the three call sites
    /// produce different concrete types (`[LibraryRoot]`, `DirContents`,
    /// `Data`). All access happens inside the actor, so the value-level
    /// `Sendable` story is safe — the dictionary itself is actor-isolated.
    private var etagCache: [String: ETagEntry] = [:]

    private struct ETagEntry {
        let etag: String
        let payload: Any
    }

    private let downloadURLSession: URLSession

    public init(http: AuthenticatedHTTPClient, server: URL,
                downloadURLSession: URLSession? = nil) {
        self.http = http
        self.server = server
        // Default download session has no shared cache — asset bodies are
        // large and the OS-side File Provider cache is the canonical store.
        // Tests inject a session whose protocolClasses include StubURLProtocol.
        self.downloadURLSession = downloadURLSession ?? URLSession(configuration: .default)
    }

    /// Drop the entire ETag cache. Called by the FP extension's
    /// ChangeFeedClient on a 409 stale-cursor reply — the cursor reset
    /// implies the cache's entries reflect pre-gap state and a 304
    /// against them would serve a stale folder/dir list.
    public func invalidateETagCache() {
        etagCache.removeAll()
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
        if let cached = etagCache[key] {
            req.setValue(cached.etag, forHTTPHeaderField: "If-None-Match")
        }
        let (data, resp) = try await http.data(for: req)
        let httpResp = resp as? HTTPURLResponse
        if httpResp?.statusCode == 304,
           let cached = etagCache[key],
           let value = cached.payload as? T {
            return value
        }
        try Self.check2xx(resp)
        let value = try decoder.decode(T.self, from: data)
        if let etag = httpResp?.value(forHTTPHeaderField: "ETag") {
            etagCache[key] = ETagEntry(etag: etag, payload: value)
        }
        return value
    }

    public func listFolders() async throws -> [LibraryRoot] {
        let url = server.appending(path: "/api/folders")
        return try await fetchCachedJSON(url: url, decode: [LibraryRoot].self)
    }

    public func listDir(absolutePath: String) async throws -> DirContents {
        var comps = URLComponents(url: server.appending(path: "/api/fs/dir"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [.init(name: "path", value: absolutePath)]
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
    /// the prior 200. Memory cost: one `Data` per asset previewed.
    /// Phase 6 will bound this with an LRU.
    public func getThumb(assetID: String) async throws -> Data {
        try Self.validateAssetID(assetID)
        let url = server.appending(path: "/api/assets/\(assetID)/thumb")
        var req = URLRequest(url: url)
        let key = url.absoluteString
        if let cached = etagCache[key] {
            req.setValue(cached.etag, forHTTPHeaderField: "If-None-Match")
        }
        let (data, resp) = try await http.data(for: req)
        let httpResp = resp as? HTTPURLResponse
        if httpResp?.statusCode == 304,
           let cached = etagCache[key],
           let bytes = cached.payload as? Data {
            return bytes
        }
        try Self.check2xx(resp)
        if let etag = httpResp?.value(forHTTPHeaderField: "ETag") {
            etagCache[key] = ETagEntry(etag: etag, payload: data)
        }
        return data
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

    // MARK: - Phase 3: uploads + trash + restore

    /// Upload a file to the given folder. Streams `fileURL` via
    /// `URLSession.upload(for:fromFile:)`. Returns `.ok` on 201,
    /// `.conflict` on 409, `.unsupported` on 415; throws on anything else.
    public func uploadFile(
        folderID: String,
        targetRelativePath: String,
        fileURL: URL,
        mtime: Date?
    ) async throws -> UploadOutcome {
        var req = URLRequest(url: server.appending(path: "/api/folders/\(folderID)/upload"))
        req.httpMethod = "POST"
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        let encoded = targetRelativePath.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? targetRelativePath
        req.setValue(encoded, forHTTPHeaderField: "X-Maple-Target-Path")
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
        if status == 409 { return .conflict }
        if status == 415 { return .unsupported }
        throw URLError(.badServerResponse)
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
