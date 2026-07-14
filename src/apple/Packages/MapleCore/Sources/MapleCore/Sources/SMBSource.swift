// SMBSource.swift — SMB 2/3 source adapter via AMSMB2.
//
// Provides read access to RAW files on an SMB share (NAS / Samba server).
// XMP sidecar writes are retried with exponential back-off.
//
// The listing call recursively walks the connected share root and surfaces
// every RAW file regardless of folder depth, because the typical NAS layout
// is `/Photos/<event>/<file>.dng` and a non-recursive root scan returns
// nothing on shares that contain only sub-folders at the top level.
//
// AMSMB2 v4 API notes:
//   - contentsOfDirectory returns [[URLResourceKey: Any]] — use .nameKey, .isDirectoryKey, .pathKey
//   - contents(atPath:range:) returns Data directly
//   - write(data:toPath:progress:) async throws
//   - disconnectShare(gracefully:) async throws
//
// AMSMB2 license: MIT (review before App Store submission).

import Foundation
import AMSMB2

// MARK: - SMBSource

/// Access RAW files on an SMB 2/3 share.
public actor SMBSource {

    // MARK: Types

    public struct SMBAsset: Sendable, Identifiable, Hashable {
        public let id: UUID
        public let path: String       // share-relative path, e.g. "/Photos/IMG_001.dng"
        /// Size + mtime as reported by the directory listing that discovered
        /// this asset (`listRAWFiles`'s `.fileSizeKey`/
        /// `.contentModificationDateKey`, both populated by AMSMB2's
        /// `stat.populateResourceValue`). Captured here so maple_id
        /// cache-validity checks (#1995) don't need a second
        /// `attributesOfItem` round-trip per asset — the listing already
        /// paid for this.
        public let size: Int64
        public let mtime: Date
        public var name: String { (path as NSString).lastPathComponent }

        public init(path: String, size: Int64 = 0, mtime: Date = .distantPast) {
            self.id = UUID()
            self.path = path
            self.size = size
            self.mtime = mtime
        }
    }

    public struct Credentials: Sendable {
        public let host: String
        public let share: String
        public let username: String
        public let password: String

        public init(host: String, share: String, username: String, password: String) {
            self.host = host
            self.share = share
            self.username = username
            self.password = password
        }
    }

    // MARK: State

    private var client: SMB2Manager?
    private var credentials: Credentials?
    private var _assets: [SMBAsset] = []

    /// Per-share maple_id cache (#1995), rooted at the connected
    /// `remotePath` — `<remotePath>/.maple/id-cache-apple.json`. `nil` until
    /// `connect` succeeds; reset to `nil` in `disconnect()`.
    private var idCache: MapleIdCacheStore?

    /// maple_id (hex) -> share-relative path, populated as a side effect of
    /// `images()` (#1995). Before #1995, `ImageRef.id` WAS the share-relative
    /// path, so `rawBytes(for:)`/`writeXMP(for:)` could read `ref.id`
    /// directly as an SMB path. Now that `id` is the content-addressed
    /// maple_id, those two methods need this map to recover the actual path
    /// — every `ImageRef` a caller can hold for this source necessarily came
    /// from a prior `images()` call (SMB has no other id-issuing entry
    /// point: `search()` returns `nil`), so the map is always populated by
    /// the time a caller round-trips a ref back into `rawBytes`/`writeXMP`.
    private var pathByMapleId: [String: String] = [:]

    /// First 64 KB of a file — the bound the primary-form head hash reads.
    /// Matches `raw_core::SHA1_HEAD_BYTES` (`id.rs`) and
    /// `FilesystemSource.mapleIdHeadByteCount`; duplicated as a literal
    /// rather than threaded across the FFI boundary for a single integer.
    private static let mapleIdHeadByteCount = 64 * 1024

    public var assets: [SMBAsset] { _assets }

    public init() {}

    // MARK: Public API

    /// Connect to an SMB share and enumerate RAW files in a path.
    public func connect(credentials: Credentials, remotePath: String = "/") async throws {
        self.credentials = credentials

        guard let serverURL = URL(string: "smb://\(credentials.host)") else {
            throw SMBError.invalidServerURL(credentials.host)
        }

        let cred = URLCredential(
            user: credentials.username,
            password: credentials.password,
            persistence: .forSession
        )
        guard let mgr = SMB2Manager(url: serverURL, credential: cred) else {
            throw SMBError.invalidServerURL(credentials.host)
        }

        try await mgr.connectShare(name: credentials.share)
        self.client = mgr
        _assets = try await listRAWFiles(at: remotePath, client: mgr)
        self.idCache = MapleIdCacheStore(
            storage: SMBIdCacheStorage(client: mgr, remotePath: remotePath))
    }

    /// Disconnect from the share.
    public func disconnect() async {
        try? await client?.disconnectShare(gracefully: false)
        client = nil
        idCache = nil
        pathByMapleId = [:]
    }

    /// Read raw bytes of an asset over SMB.
    public func rawData(for asset: SMBAsset) async throws -> Data {
        guard let client else { throw SMBError.notConnected }
        return try await client.contents(atPath: asset.path, range: Range<UInt64>?.none)
    }

    /// Write XMP sidecar bytes over SMB with retry (3 attempts, exponential back-off).
    public func writeSidecar(_ data: Data, for asset: SMBAsset) async throws {
        guard let client else { throw SMBError.notConnected }
        let sidecarPath = (asset.path as NSString)
            .deletingPathExtension
            .appending(".xmp")
        try await writeWithRetry(data: data, to: sidecarPath, client: client)
    }

    // MARK: Private

    /// Recursively enumerate RAW files under `path`. AMSMB2's `recursive: true`
    /// flag walks the whole subtree in one round-trip and stamps each entry's
    /// `.pathKey` with its full share-relative path (e.g.
    /// `/Photos/2024/IMG_001.dng`). Directories and dotfiles are skipped.
    ///
    /// Recursive enumeration matches the user's expectation that "open the
    /// share, see all my photos" works regardless of whether the RAWs sit at
    /// the share root or three folders deep — the prior non-recursive walk
    /// returned an empty list whenever the root contained only sub-folders,
    /// which is the common NAS layout (`/Photos/`, `/Backups/`, etc.).
    private func listRAWFiles(at path: String, client: SMB2Manager) async throws -> [SMBAsset] {
        let entries = try await client.contentsOfDirectory(atPath: path, recursive: true)
        return entries.compactMap { attrs -> SMBAsset? in
            guard let name = attrs[.nameKey] as? String else { return nil }
            // Skip dotfiles (`.DS_Store`, `.maple/`, etc.).
            if name.hasPrefix(".") { return nil }
            let isDir = attrs[.isDirectoryKey] as? Bool ?? false
            guard !isDir else { return nil }
            let ext = (name as NSString).pathExtension.lowercased()
            guard SupportedImageExtensions.all.contains(ext) else { return nil }
            // `.pathKey` is the full share-relative path stamped by AMSMB2's
            // recursive walk; fall back to joining `path + name` when the
            // server didn't populate it (non-recursive root scan).
            let fullPath = (attrs[.pathKey] as? String)
                ?? (path as NSString).appendingPathComponent(name)
            // `.fileSizeKey` / `.contentModificationDateKey` are populated by
            // AMSMB2's `stat.populateResourceValue` on every directory-listing
            // entry (see `FileHandle.swift` in the vendored AMSMB2 checkout) —
            // capture them now so maple_id cache-validity checks (#1995)
            // don't need a second per-asset round-trip.
            let size = (attrs[.fileSizeKey] as? NSNumber)?.int64Value ?? 0
            let mtime = attrs[.contentModificationDateKey] as? Date ?? .distantPast
            return SMBAsset(path: fullPath, size: size, mtime: mtime)
        }.sorted { $0.path < $1.path }
    }

    private func writeWithRetry(data: Data, to path: String, client: SMB2Manager,
                                maxAttempts: Int = 3) async throws {
        var lastError: Error?
        for attempt in 0..<maxAttempts {
            do {
                try await client.write(data: data, toPath: path, progress: nil)
                return
            } catch {
                lastError = error
                if attempt < maxAttempts - 1 {
                    let delay = UInt64(pow(2.0, Double(attempt))) * 1_000_000_000
                    try? await Task.sleep(nanoseconds: delay)
                }
            }
        }
        throw lastError ?? SMBError.writeFailedAfterRetries
    }

    // MARK: - maple_id derivation (#1995)

    /// Resolve a maple_id for `asset`, consulting the share's id-cache first
    /// (`MapleIdCacheStore.lookup`) and only re-deriving (then persisting) on
    /// a cache miss or a stale entry (size/mtime mismatch — the file was
    /// replaced at this path since the id was last computed). Returns `nil`
    /// when not connected or derivation itself fails; `images()` falls back
    /// to the share-relative path in that case.
    ///
    /// Staleness scope: `asset.size`/`asset.mtime` come from the listing
    /// snapshot taken at `connect()` (`listRAWFiles`), not a fresh
    /// `attributesOfItem` stat per call — an intentional trade-off, unlike
    /// `FilesystemSource.mapleId(for:)`, which DOES re-stat on every call
    /// (cheap: a local syscall). Re-statting every asset over SMB on every
    /// `images()` call would reintroduce a per-file network round-trip on
    /// every UI refresh — exactly the cost this cache exists to avoid. A
    /// file replaced at the same path is still correctly detected across
    /// browses (each `connect()` re-lists and captures fresh size/mtime),
    /// just not for a replacement that happens to land between two
    /// `images()` calls on the SAME still-open connection without an
    /// intervening reconnect.
    private func mapleId(for asset: SMBAsset) async -> String? {
        guard let client, let idCache else { return nil }
        if let cached = await idCache.lookup(path: asset.path, size: asset.size, mtime: asset.mtime.timeIntervalSince1970) {
            return cached
        }
        guard let derived = await deriveMapleId(for: asset, client: client) else { return nil }
        await idCache.record(
            path: asset.path, mapleId: derived,
            size: asset.size, mtime: asset.mtime.timeIntervalSince1970)
        return derived
    }

    /// Derive a maple_id from scratch over SMB: a single bounded range read
    /// (`0..<64KB`) supplies BOTH the primary-form head hash input and the
    /// EXIF extraction buffer (real camera RAWs — all TIFF-based — keep
    /// their EXIF IFD near the start of the file, well within 64 KB; when
    /// that assumption doesn't hold for a given file, EXIF extraction simply
    /// finds nothing and this correctly falls through to fallback form
    /// rather than mis-deriving). Only when primary form isn't viable does
    /// this stream the WHOLE file — via AMSMB2's native
    /// `AsyncThrowingStream` range-read API, never materialised as one
    /// buffer — through `FallbackFormHasher`.
    private func deriveMapleId(for asset: SMBAsset, client: SMB2Manager) async -> String? {
        guard let headBytes = try? await client.contents(
            atPath: asset.path, range: UInt64(0)..<UInt64(Self.mapleIdHeadByteCount))
        else { return nil }
        guard !headBytes.isEmpty else { return nil }

        let dates = ImageMetadataReader.readRawCaptureDateStrings(from: headBytes)

        // ONE stream, ONE iterator, shared by reference across every
        // `nextChunk()` call — `client.contents(atPath:)` opens a fresh
        // `SMB2FileHandle` and starts reading from byte 0 each time it's
        // called, so calling it again per chunk would silently re-read the
        // same leading bytes forever instead of advancing through the file.
        var iterator = client.contents(atPath: asset.path).makeAsyncIterator()

        // `try?`: a mid-stream SMB read failure (dropped connection, etc.)
        // must not surface a partial/wrong id — `derive` is `rethrows`
        // because `nextChunk` can throw, so a thrown error here correctly
        // collapses to `nil`, matching this function's established
        // fail-safe-to-nil contract (see the `headBytes` guard above).
        return try? await MapleIdDerivation.derive(
            headBytes: headBytes,
            exifDateTimeOriginal: dates.dateTimeOriginal,
            exifCreateDate: dates.createDate,
            filesize: UInt64(asset.size),
            nextChunk: {
                (try await iterator.next()) ?? Data()
            }
        )
    }
}

// MARK: - SMBIdCacheStorage

/// AMSMB2-backed `MapleIdCacheStorage` (#1995) for an SMB share. Mirrors
/// `LocalIdCacheStorage`'s contract exactly, routed through `SMB2Manager`
/// instead of `FileManager` — the id-cache files live ON THE SHARE (at
/// `<remotePath>/.maple/id-cache-*.json`), so a Mac app and a Web Hosted tab
/// browsing the same NAS folder can see each other's cached ids.
struct SMBIdCacheStorage: MapleIdCacheStorage {
    private let client: SMB2Manager
    private let mapleDirPath: String

    init(client: SMB2Manager, remotePath: String) {
        self.client = client
        self.mapleDirPath = (remotePath as NSString).appendingPathComponent(".maple")
    }

    private func filePath(_ name: String) -> String {
        (mapleDirPath as NSString).appendingPathComponent(name)
    }

    func ensureDirectory() async {
        // "Already exists" is not an error from this call's perspective —
        // matches `LocalIdCacheStorage.ensureDirectory`'s `try?`.
        try? await client.createDirectory(atPath: mapleDirPath)
    }

    func listIdCacheFileNames() async -> [String] {
        guard let entries = try? await client.contentsOfDirectory(atPath: mapleDirPath, recursive: false)
        else { return [] }
        return entries
            .compactMap { $0[.nameKey] as? String }
            .filter { $0.hasPrefix("id-cache-") && $0.hasSuffix(".json") }
    }

    func readIdCacheFile(name: String) async -> Data? {
        try? await client.contents(atPath: filePath(name))
    }

    func writeIdCacheFile(name: String, data: Data) async {
        // Temp-file-then-rename rather than a direct write to the final
        // path: a dropped SMB connection mid-write would otherwise leave a
        // truncated/corrupt id-cache file that other readers could observe.
        // With temp+rename, a drop mid-write only corrupts the temp file —
        // the previously-good final file is untouched until the rename.
        //
        // SMB2 rename (`moveItem`) is not guaranteed to overwrite an
        // existing destination (server-dependent `ReplaceIfExists`
        // semantics) — best-effort remove the previous file first so the
        // rename that follows lands cleanly; "didn't exist yet" is the
        // expected outcome on a first write and its failure is swallowed.
        let tmpPath = filePath(".\(name).tmp-\(UUID().uuidString)")
        let finalPath = filePath(name)
        do {
            try await client.write(data: data, toPath: tmpPath, progress: nil)
            try? await client.removeItem(atPath: finalPath)
            try await client.moveItem(atPath: tmpPath, toPath: finalPath)
        } catch {
            try? await client.removeItem(atPath: tmpPath)
        }
    }
}

// MARK: - ImageSource conformance

extension SMBSource: ImageSource {
    /// Map enumerated `SMBAsset`s to `ImageRef`. `id` is the spec-form
    /// `maple_id` hex (#1995) — see `FilesystemSource.images()`'s doc
    /// comment for why (content-addressed id shared with the server indexer
    /// and Web, not a source-local path). Falls back to the share-relative
    /// path only when derivation genuinely fails. `url` is left `nil` so
    /// `BrowseViewModel.loadSource` routes byte reads through
    /// `rawBytes(for:)` (the bytes-provider branch) — the Rust decode pipeline
    /// can't open an `smb://` URL as a file URL, so the prior synthetic URL
    /// caused decodes to fail silently downstream.
    public func images() async throws -> [ImageRef] {
        var refs: [ImageRef] = []
        refs.reserveCapacity(_assets.count)
        var freshPathByMapleId: [String: String] = [:]
        for a in _assets {
            let id = await mapleId(for: a) ?? a.path
            freshPathByMapleId[id] = a.path
            refs.append(ImageRef(id: id, displayName: a.name, url: nil))
        }
        pathByMapleId = freshPathByMapleId
        return refs
    }

    public func thumb(for ref: ImageRef) async throws -> Data? { nil }
    public func preview(for ref: ImageRef) async throws -> Data? { nil }

    public func rawBytes(for ref: ImageRef) async throws -> Data {
        guard let client else { throw SMBError.notConnected }
        return try await client.contents(atPath: path(for: ref), range: Range<UInt64>?.none)
    }

    public func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {
        guard let client else { throw SMBError.notConnected }
        let xml = XMPSerializer.serialize(model: sidecar.model, culling: sidecar.culling)
        guard let data = xml.data(using: .utf8) else {
            throw XMPStoreError.encodingError
        }
        let sidecarPath = (path(for: ref) as NSString)
            .deletingPathExtension
            .appending(".xmp")
        try await writeWithRetry(data: data, to: sidecarPath, client: client)
    }

    /// Resolve `ref.id` (the maple_id hex, #1995) back to the share-relative
    /// path `rawBytes`/`writeXMP` actually need to address the file over
    /// SMB. Falls back to treating `ref.id` itself as the path — covers the
    /// (expected-rare) case where maple_id derivation failed for this asset
    /// and `images()` fell back to the path as the id, so `pathByMapleId`
    /// maps it to itself anyway; this fallback just avoids a spurious lookup
    /// miss in that case.
    private func path(for ref: ImageRef) -> String {
        pathByMapleId[ref.id] ?? ref.id
    }

    /// SMB shares have no server-side index.
    public func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }
}

// MARK: - SMBError

public enum SMBError: Error, LocalizedError {
    case invalidServerURL(String)
    case notConnected
    case writeFailedAfterRetries

    public var errorDescription: String? {
        switch self {
        case .invalidServerURL(let h):  return "Invalid SMB server URL: \(h)"
        case .notConnected:             return "Not connected to SMB share"
        case .writeFailedAfterRetries:  return "SMB sidecar write failed after retries"
        }
    }
}
