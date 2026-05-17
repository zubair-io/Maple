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
}

public struct ImageChild: Codable, Equatable, Sendable {
    public let name: String
    public let path: String
    public let mtime: Date
    public let size: Int64
    public let ext: String
    public let assetID: String?     // server-side Mongo ObjectId; nil if not yet indexed

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
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    public init(http: AuthenticatedHTTPClient, server: URL) {
        self.http = http; self.server = server
    }

    public func listFolders() async throws -> [LibraryRoot] {
        let req = URLRequest(url: server.appending(path: "/api/folders"))
        let (data, resp) = try await http.data(for: req)
        try Self.check2xx(resp)
        return try decoder.decode([LibraryRoot].self, from: data)
    }

    public func listDir(absolutePath: String) async throws -> DirContents {
        var comps = URLComponents(url: server.appending(path: "/api/fs/dir"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [.init(name: "path", value: absolutePath)]
        let req = URLRequest(url: comps.url!)
        let (data, resp) = try await http.data(for: req)
        try Self.check2xx(resp)
        return try decoder.decode(DirContents.self, from: data)
    }

    // Phase 1 simplification: full-body buffering. A 100MP RAW spikes ~150MB.
    // Acceptable on macOS; revisit with URLSession.download(for:) before iOS.
    public func downloadAsset(assetID: String, to localURL: URL) async throws {
        try Self.validateAssetID(assetID)
        let req = URLRequest(url: server.appending(path: "/api/assets/\(assetID)/raw"))
        let (data, resp) = try await http.data(for: req)
        try Self.check2xx(resp)
        try data.write(to: localURL, options: .atomic)
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
    /// Note: every spacebar press re-fetches the JPEG today. An ETag /
    /// `If-None-Match` in-memory cache lands in Phase 5c (perf pass) and
    /// is intentionally out of scope for 5a — see
    /// `docs/superpowers/plans/2026-05-16-file-provider-phase5c-perf.md`.
    public func getThumb(assetID: String) async throws -> Data {
        try Self.validateAssetID(assetID)
        let req = URLRequest(url: server.appending(path: "/api/assets/\(assetID)/thumb"))
        let (data, resp) = try await http.data(for: req)
        try Self.check2xx(resp)
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
}
