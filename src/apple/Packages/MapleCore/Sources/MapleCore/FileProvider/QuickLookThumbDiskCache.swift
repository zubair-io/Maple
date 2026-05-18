// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/QuickLookThumbDiskCache.swift
//
// Disk cache for Quick Look thumb bytes, keyed by (assetID, etag) and
// persisted under the App Group container so it survives QL extension
// restarts. Phase 6 item 4 of the file-provider sweep
// (`docs/superpowers/specs/2026-05-17-file-provider-phase6-design.md`).
//
// The QL extension is short-lived — every spacebar press in a fresh
// session re-fetches the thumb from the server. The in-memory ETag
// cache on RemoteCatalog covers same-process reuse only. This disk
// cache turns the second spacebar across sessions into a no-network
// read.
//
// Eviction: TTL (entries with mtime older than `ttl` drop on lazy
// sweep) plus a size cap (oldest-by-mtime evicted when a write would
// push past `sizeCap`). LRU-by-mtime is approximated by updating the
// modification date on read.

import Foundation
import CryptoKit
import OSLog

/// Disk-backed cache for Quick Look thumbnail bytes.
///
/// Layout: `<containerURL>/QuickLookThumbs/<assetID>.<etagSha1>.jpg`.
/// A new ETag value naturally lands as a new file; the old file
/// becomes orphaned and is reaped by the next size-cap sweep.
///
/// Concurrency: an actor — every read/write goes through one
/// serialised queue. The disk-cache itself can be shared across
/// `providePreview` invocations safely; the QL appex instantiates
/// `QuickLookThumbDiskCache.shared` once per process and reuses it.
public actor QuickLookThumbDiskCache {
    /// Default shared instance. Resolves the cache dir + UserDefaults
    /// from the App Group container at first access. The QL appex and
    /// the host app both consult this same instance via their own
    /// process-local copy — they don't share the actor across
    /// processes (no XPC), but they DO share the on-disk files and
    /// the `quicklook.thumb-etags` defaults dict.
    public static let shared = QuickLookThumbDiskCache()

    private let log = Logger(subsystem: "app.justmaple.aperture.quicklook",
                             category: "thumb-disk-cache")
    private let fm = FileManager.default
    private let cacheDir: URL?
    private let defaults: UserDefaults

    /// Soft TTL for entries. Read older than this on next access ->
    /// evict. 7 days matches the spec; long enough that "did I just
    /// look at this last week?" stays a fast spacebar.
    public let ttl: TimeInterval

    /// Hard cap on aggregate cache size. Sweep deletes oldest-by-mtime
    /// when a write would push past this. 200 MB is the spec default —
    /// roughly 2,000–4,000 typical JPEG thumbs at 50–100 KB each.
    public let sizeCap: Int64

    /// Maximum entries in the `lastKnownETag` defaults dict. The disk
    /// file is the actual cache; this is just a pointer to the most
    /// recent ETag observed per assetID. FIFO-evict the oldest entry
    /// when full. 1024 covers a comfortable working set without
    /// bloating App Group defaults (which is read by every FP extension
    /// launch and should stay small).
    public let etagDictCap: Int

    /// Defaults key for the `[assetID: etag]` dict.
    public static let etagsDefaultsKey = "quicklook.thumb-etags"

    /// In-memory cache of total cache-dir size in bytes. Refreshed by
    /// `recomputeTotalSizeIfNeeded` — every read does NOT traverse the
    /// directory. `nil` = unknown, recompute next time we need it
    /// (e.g. before a size-cap-gated write).
    private var totalSizeCache: Int64?

    /// `Date` of the last full TTL sweep. The sweep walks the directory
    /// and unlinks anything past TTL. We gate it to once per
    /// `sweepInterval` so spacebar-walks across hundreds of assets in
    /// one session don't restat the whole dir on every read.
    private var lastSweepAt: Date?

    /// How often the TTL sweep can run, at most. 5 minutes is short
    /// enough that a fresh session sees a recent sweep but long enough
    /// that hundreds of spacebar presses don't keep restatting.
    private let sweepInterval: TimeInterval = 5 * 60

    /// Designated initialiser. All parameters are injectable so tests
    /// can point at a tmp dir + isolated UserDefaults instead of the
    /// real App Group container.
    ///
    /// `containerURL == nil` → resolves the App Group container at
    /// init time via `FileManager.containerURL(forSecurityApplicationGroupIdentifier:)`.
    /// If the App Group is unreachable (entitlement missing,
    /// sandbox stripped, simulator quirks), the cache becomes a no-op
    /// — same degradation shape as `FileProviderConfig`.
    public init(
        containerURL: URL? = nil,
        defaults: UserDefaults? = nil,
        ttl: TimeInterval = 7 * 24 * 60 * 60,
        sizeCap: Int64 = 200 * 1024 * 1024,
        etagDictCap: Int = 1024
    ) {
        self.ttl = ttl
        self.sizeCap = sizeCap
        self.etagDictCap = etagDictCap

        // Cache directory.
        let resolved: URL?
        if let containerURL {
            resolved = containerURL.appendingPathComponent("QuickLookThumbs",
                                                           isDirectory: true)
        } else if let group = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: FileProviderConfig.appGroupSuiteName
        ) {
            resolved = group.appendingPathComponent("QuickLookThumbs",
                                                    isDirectory: true)
        } else {
            resolved = nil
        }
        if let dir = resolved {
            try? FileManager.default.createDirectory(
                at: dir, withIntermediateDirectories: true
            )
        }
        self.cacheDir = resolved

        // Defaults for the lastKnownETag dict.
        if let d = defaults {
            self.defaults = d
        } else if let group = UserDefaults(suiteName: FileProviderConfig.appGroupSuiteName) {
            self.defaults = group
        } else {
            self.defaults = .standard
        }
    }

    /// Fetch the JPEG bytes for `assetID`, consulting the disk cache
    /// first and revalidating against `fetch` if needed.
    ///
    /// The closure performs the actual server round-trip — passed in
    /// to keep `RemoteCatalog` decoupled from the disk cache and to
    /// keep this type unit-testable without a live URLSession. The
    /// closure receives the `ifNoneMatch` ETag (nil if we have no
    /// pointer for the asset) and returns a `ThumbFetchResult`.
    ///
    /// Behaviour:
    /// - Disk hit with a stored ETag → send `If-None-Match`, accept 304.
    /// - 304 → return disk bytes, refresh mtime.
    /// - 200 with a NEW etag → write to disk under the new key,
    ///   update the lastKnownETag pointer.
    /// - 200 without an ETag (server quirk) → return bytes, no cache
    ///   write (we'd have no stable key for them).
    public func fetch(
        assetID: String,
        using fetch: @Sendable (_ ifNoneMatch: String?) async throws -> RemoteCatalog.ThumbFetchResult
    ) async throws -> Data {
        // No cache dir = degraded mode, straight pass-through.
        guard let dir = cacheDir else {
            let result = try await fetch(nil)
            switch result {
            case .ok(let data, _): return data
            case .notModified:
                throw URLError(.cannotDecodeContentData)
            }
        }

        sweepIfNeeded(dir: dir)

        let lastETag = loadETag(assetID: assetID)
        let cachedPath = lastETag.map { fileURL(in: dir, assetID: assetID, etag: $0) }

        // Disk hit + known ETag → revalidate.
        if let path = cachedPath, fm.fileExists(atPath: path.path) {
            let result = try await fetch(lastETag)
            switch result {
            case .notModified:
                if let bytes = try? Data(contentsOf: path) {
                    touch(path)
                    return bytes
                }
                // Disk read failed despite fileExists check; fall through
                // to a no-conditional refetch.
                log.notice("disk read failed after 304, refetching")
            case .ok(let data, let newETag):
                if let newETag, newETag != lastETag {
                    writeEntry(dir: dir, assetID: assetID, etag: newETag, data: data)
                    saveETag(assetID: assetID, etag: newETag)
                } else if let newETag {
                    // Same ETag came back on a 200 — refresh disk + mtime.
                    writeEntry(dir: dir, assetID: assetID, etag: newETag, data: data)
                }
                return data
            }
        }

        // No usable disk entry → fetch unconditionally.
        let result = try await fetch(nil)
        switch result {
        case .ok(let data, let newETag):
            if let newETag {
                writeEntry(dir: dir, assetID: assetID, etag: newETag, data: data)
                saveETag(assetID: assetID, etag: newETag)
            }
            return data
        case .notModified:
            // A 304 without sending If-None-Match is a server bug; treat
            // as an unreadable response.
            throw URLError(.cannotDecodeContentData)
        }
    }

    // MARK: - Test accessors

    /// Number of `.jpg` files currently in the cache dir.
    /// Test-only — production callers use `fetch` and don't care.
    internal func _entryCountForTesting() -> Int {
        guard let dir = cacheDir else { return 0 }
        let urls = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        return urls.filter { $0.pathExtension == "jpg" }.count
    }

    /// Aggregate size in bytes of all `.jpg` files in the cache dir.
    internal func _totalSizeForTesting() -> Int64 {
        guard let dir = cacheDir else { return 0 }
        return computeTotalSize(dir: dir)
    }

    /// Number of entries in the lastKnownETag dict.
    internal func _etagDictCountForTesting() -> Int {
        loadETagDict().etags.count
    }

    /// Force a TTL sweep (test-only — production gates on `sweepInterval`).
    internal func _runSweepForTesting() {
        guard let dir = cacheDir else { return }
        runTTLSweep(dir: dir)
        lastSweepAt = Date()
    }

    // MARK: - Disk path / file ops

    private func fileURL(in dir: URL, assetID: String, etag: String) -> URL {
        let etagKey = etagHash(etag)
        return dir.appendingPathComponent("\(assetID).\(etagKey).jpg")
    }

    private func writeEntry(dir: URL, assetID: String, etag: String, data: Data) {
        let url = fileURL(in: dir, assetID: assetID, etag: etag)
        // Reserve room: if this write would push us past sizeCap, evict
        // until there's space. Compute current size lazily — we only
        // pay the directory walk on writes that might overflow.
        let incomingSize = Int64(data.count)
        evictForSizeIfNeeded(dir: dir, incomingSize: incomingSize, excluding: url)
        do {
            try data.write(to: url, options: .atomic)
            // Invalidate the cached total — next reserve recomputes.
            totalSizeCache = nil
        } catch {
            log.notice("write failed for \(assetID, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    private func touch(_ url: URL) {
        try? fm.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
    }

    // MARK: - Eviction

    /// Evict oldest-by-mtime entries if writing `incomingSize` bytes
    /// would exceed `sizeCap`. `excluding` is the URL of the file
    /// about to be written — never evict it (the new entry's existence
    /// is irrelevant to the new write).
    private func evictForSizeIfNeeded(dir: URL, incomingSize: Int64, excluding: URL) {
        let current = recomputeTotalSizeIfNeeded(dir: dir)
        if current + incomingSize <= sizeCap { return }

        // Walk the dir, collect (url, mtime, size), sort by mtime asc,
        // delete from oldest until we're under cap.
        let urls = (try? fm.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        struct Entry { let url: URL; let mtime: Date; let size: Int64 }
        var entries: [Entry] = []
        for u in urls where u.pathExtension == "jpg" && u != excluding {
            let vals = try? u.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
            let mtime = vals?.contentModificationDate ?? .distantPast
            let size = Int64(vals?.fileSize ?? 0)
            entries.append(Entry(url: u, mtime: mtime, size: size))
        }
        entries.sort { $0.mtime < $1.mtime }

        var running = current
        var freed: Int64 = 0
        for e in entries {
            if running + incomingSize <= sizeCap { break }
            try? fm.removeItem(at: e.url)
            running -= e.size
            freed += e.size
        }
        if freed > 0 {
            log.notice("size-cap evicted \(freed, privacy: .public) bytes")
        }
        totalSizeCache = running
    }

    private func runTTLSweep(dir: URL) {
        let cutoff = Date().addingTimeInterval(-ttl)
        let urls = (try? fm.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        var evicted = 0
        for u in urls where u.pathExtension == "jpg" {
            let vals = try? u.resourceValues(forKeys: [.contentModificationDateKey])
            let mtime = vals?.contentModificationDate ?? .distantPast
            if mtime < cutoff {
                try? fm.removeItem(at: u)
                evicted += 1
            }
        }
        if evicted > 0 {
            log.notice("ttl evicted \(evicted, privacy: .public) entries older than \(self.ttl, privacy: .public)s")
            totalSizeCache = nil
        }
    }

    private func sweepIfNeeded(dir: URL) {
        let now = Date()
        if let last = lastSweepAt, now.timeIntervalSince(last) < sweepInterval {
            return
        }
        runTTLSweep(dir: dir)
        lastSweepAt = now
    }

    private func computeTotalSize(dir: URL) -> Int64 {
        let urls = (try? fm.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: [.fileSizeKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        var total: Int64 = 0
        for u in urls where u.pathExtension == "jpg" {
            let vals = try? u.resourceValues(forKeys: [.fileSizeKey])
            total += Int64(vals?.fileSize ?? 0)
        }
        return total
    }

    private func recomputeTotalSizeIfNeeded(dir: URL) -> Int64 {
        if let cached = totalSizeCache { return cached }
        let total = computeTotalSize(dir: dir)
        totalSizeCache = total
        return total
    }

    // MARK: - lastKnownETag dict (App Group defaults)

    /// Wire format: a JSON object encoded into a single defaults blob
    /// with two parallel arrays — `etags` is the map, `order` is the
    /// FIFO insertion order used for cap eviction. Storing as JSON
    /// keeps the schema explicit and rules out cross-version surprises
    /// from defaults' weak typing.
    private struct ETagDict: Codable {
        var etags: [String: String]
        var order: [String]
    }

    private func loadETagDict() -> ETagDict {
        guard let data = defaults.data(forKey: Self.etagsDefaultsKey),
              let dict = try? JSONDecoder().decode(ETagDict.self, from: data) else {
            return ETagDict(etags: [:], order: [])
        }
        return dict
    }

    private func saveETagDict(_ dict: ETagDict) {
        guard let data = try? JSONEncoder().encode(dict) else { return }
        defaults.set(data, forKey: Self.etagsDefaultsKey)
    }

    private func loadETag(assetID: String) -> String? {
        loadETagDict().etags[assetID]
    }

    private func saveETag(assetID: String, etag: String) {
        var dict = loadETagDict()
        if dict.etags[assetID] != nil {
            // Refresh in place; don't reorder (FIFO is about insertion).
            dict.etags[assetID] = etag
        } else {
            dict.etags[assetID] = etag
            dict.order.append(assetID)
            // FIFO cap: evict oldest insertions until we're at or under cap.
            while dict.order.count > etagDictCap {
                let oldest = dict.order.removeFirst()
                dict.etags.removeValue(forKey: oldest)
            }
        }
        saveETagDict(dict)
    }

    // MARK: - Hash

    /// SHA-1 of the ETag, hex-encoded, prefix-16. ETags include quotes
    /// and special characters; hashing keeps the filename safe and
    /// short. SHA-1 is fine here — collision risk is "two ETag strings
    /// happen to hash the same, second one orphans the first on disk",
    /// which is non-malicious and self-healing on next fetch.
    private func etagHash(_ etag: String) -> String {
        let digest = Insecure.SHA1.hash(data: Data(etag.utf8))
        return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    }
}
