// src/apple/Packages/MapleCore/Sources/MapleCore/FileProvider/QuickLookThumbDiskCache.swift
//
// Disk cache for Quick Look thumb bytes, keyed by (assetID, etag) and
// persisted under the App Group container so it survives QL extension
// restarts. Phase 6 item 4 of the file-provider sweep
// (`.archived-plans/specs/2026-05-17-file-provider-phase6-design.md`).
//
// The QL extension is short-lived — every spacebar press in a fresh
// session re-fetches the thumb from the server. The in-memory ETag
// cache on RemoteCatalog covers same-process reuse only. This disk
// cache avoids re-downloading the AVIF payload across sessions —
// the cache still revalidates via If-None-Match every spacebar.
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
/// Layout: `<containerURL>/QuickLookThumbs/<assetID>.<etagSha1>.avif`.
/// A new ETag value naturally lands as a new file; the old file
/// becomes orphaned and is reaped by the next size-cap sweep. Legacy
/// `.jpg` entries from before the thumbnail AVIF migration are recognized
/// by the eviction/sweep filters too (permanently — see `recognizedExtensions`)
/// so they still age out normally instead of leaking in the App Group
/// container; new writes are always `.avif`.
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
    /// Per-asset ETag pointer directory at `<cacheDir>/etag-pointers/`.
    /// Each pointer is a tiny text file containing the asset's last
    /// observed ETag; the filename is the sha1 of the assetID. Per-file
    /// granularity means concurrent writes for DIFFERENT assets do not
    /// collide at all — eliminating the cross-process race that an
    /// App Group UserDefaults dict would otherwise have.
    private let pointersDir: URL?
    /// Retained for source compatibility; the previous implementation
    /// stored the [assetID: etag] map in this UserDefaults instance.
    /// The per-asset pointer-file layout makes it unused — kept so
    /// existing callers (tests, host app initialiser) don't break.
    private let defaults: UserDefaults

    /// Soft TTL for entries. Read older than this on next access ->
    /// evict. 7 days matches the spec; long enough that "did I just
    /// look at this last week?" stays a fast spacebar.
    public let ttl: TimeInterval

    /// Hard cap on aggregate cache size. Sweep deletes oldest-by-mtime
    /// when a write would push past this. 200 MB is the spec default —
    /// roughly 2,000–4,000 typical AVIF thumbs at 50–100 KB each.
    public let sizeCap: Int64

    /// Maximum entries in the lastKnownETag pointer directory. The
    /// disk file is the actual cache; pointers just record the most
    /// recent ETag observed per assetID. Oldest-by-mtime evicted when
    /// the count exceeds the cap. 1024 covers a comfortable working
    /// set without bloating the App Group container.
    public let etagDictCap: Int

    /// Legacy key from the old UserDefaults-dict implementation;
    /// retained for documentation purposes only — the cache now uses
    /// per-asset pointer files under `etag-pointers/`.
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

    /// Extensions every eviction/sweep/count filter recognizes as a cache
    /// entry. `avif` is current; `jpg` is the pre-migration legacy format —
    /// kept permanently (not time-boxed) so orphaned legacy entries keep
    /// aging out via the existing TTL/size-cap sweeps rather than leaking.
    private static let recognizedExtensions: Set<String> = ["avif", "jpg"]

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
        // Pointer subdir lives alongside the .avif (and legacy .jpg) cache
        // files. Per-asset pointer files eliminate the cross-process RMW
        // race that the previous UserDefaults dict had.
        if let dir = resolved {
            let pdir = dir.appendingPathComponent("etag-pointers", isDirectory: true)
            try? FileManager.default.createDirectory(
                at: pdir, withIntermediateDirectories: true
            )
            self.pointersDir = pdir
        } else {
            self.pointersDir = nil
        }

        // Defaults retained for source compatibility; unused.
        if let d = defaults {
            self.defaults = d
        } else if let group = UserDefaults(suiteName: FileProviderConfig.appGroupSuiteName) {
            self.defaults = group
        } else {
            self.defaults = .standard
        }
    }

    /// Fetch the AVIF bytes for `assetID`, consulting the disk cache
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
        // Shape-validate before letting the value anywhere near a file
        // path. A malformed `assetID` containing `/` or `..` would
        // otherwise escape `cacheDir` once interpolated into the
        // filename — see `fileURL(in:assetID:etag:)`. The validator
        // enforces the 24-hex Mongo ObjectID format the API guarantees.
        try RemoteCatalog.validateAssetID(assetID)

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

    /// Number of cache-entry files (`.avif` or legacy `.jpg`) currently in
    /// the cache dir. Test-only — production callers use `fetch` and don't
    /// care.
    internal func _entryCountForTesting() -> Int {
        guard let dir = cacheDir else { return 0 }
        let urls = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        return urls.filter { Self.recognizedExtensions.contains($0.pathExtension) }.count
    }

    /// Aggregate size in bytes of all cache-entry files in the cache dir.
    internal func _totalSizeForTesting() -> Int64 {
        guard let dir = cacheDir else { return 0 }
        return computeTotalSize(dir: dir)
    }

    /// Number of pointer files in the etag-pointers subdir.
    internal func _etagDictCountForTesting() -> Int {
        guard let pdir = pointersDir else { return 0 }
        let urls = (try? fm.contentsOfDirectory(at: pdir, includingPropertiesForKeys: nil)) ?? []
        return urls.filter { $0.pathExtension == "txt" }.count
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
        return dir.appendingPathComponent("\(assetID).\(etagKey).avif")
    }

    private func writeEntry(dir: URL, assetID: String, etag: String, data: Data) {
        let url = fileURL(in: dir, assetID: assetID, etag: etag)
        let incomingSize = Int64(data.count)
        // Oversize bypass: a single payload larger than the entire
        // sizeCap can never legitimately live in the cache. Skip the
        // write before eviction runs — otherwise the eviction sweep
        // wipes every other entry trying to make room, and we'd land
        // a file that itself blows past the documented hard cap.
        // Caller still receives the bytes from `fetch`.
        if incomingSize > sizeCap {
            log.notice("skipping cache write: payload \(incomingSize, privacy: .public)B exceeds sizeCap \(self.sizeCap, privacy: .public)B")
            return
        }
        // Reserve room: if this write would push us past sizeCap, evict
        // until there's space. Compute current size lazily — we only
        // pay the directory walk on writes that might overflow.
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
    ///
    /// When the same (assetID, etag) is being refreshed in place (a
    /// 200 reply with the ETag we already have on disk), `current`
    /// already includes the existing file's bytes. The naive
    /// `current + incomingSize` comparison double-counts that file
    /// against the cap and can trigger spurious eviction of unrelated
    /// older entries. Subtract the existing file's size — if any —
    /// from `current` so we measure the post-write footprint instead.
    ///
    /// Also resolves both paths via `resolvingSymlinksInPath()` before
    /// comparing: `contentsOfDirectory(at:)` returns symlink-resolved
    /// URLs (e.g. `/private/var/...`) while `appendingPathComponent`
    /// doesn't, so raw `==` would never match and the `excluding`
    /// filter would silently no-op.
    private func evictForSizeIfNeeded(dir: URL, incomingSize: Int64, excluding: URL) {
        let excludingPath = excluding.resolvingSymlinksInPath().path
        let existingSize: Int64
        if let attrs = try? fm.attributesOfItem(atPath: excluding.path),
           let size = attrs[.size] as? NSNumber {
            existingSize = size.int64Value
        } else {
            existingSize = 0
        }
        let current = recomputeTotalSizeIfNeeded(dir: dir)
        let projected = current - existingSize + incomingSize
        if projected <= sizeCap { return }

        // Walk the dir, collect (url, mtime, size), sort by mtime asc,
        // delete from oldest until we're under cap.
        let urls = (try? fm.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        struct Entry { let url: URL; let mtime: Date; let size: Int64 }
        var entries: [Entry] = []
        for u in urls where Self.recognizedExtensions.contains(u.pathExtension) {
            if u.resolvingSymlinksInPath().path == excludingPath { continue }
            let vals = try? u.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
            let mtime = vals?.contentModificationDate ?? .distantPast
            let size = Int64(vals?.fileSize ?? 0)
            entries.append(Entry(url: u, mtime: mtime, size: size))
        }
        entries.sort { $0.mtime < $1.mtime }

        var running = projected
        var freed: Int64 = 0
        for e in entries {
            if running <= sizeCap { break }
            try? fm.removeItem(at: e.url)
            running -= e.size
            freed += e.size
        }
        if freed > 0 {
            log.notice("size-cap evicted \(freed, privacy: .public) bytes")
        }
        // Invalidate — the upcoming writeEntry will recompute on next need.
        totalSizeCache = nil
    }

    private func runTTLSweep(dir: URL) {
        let cutoff = Date().addingTimeInterval(-ttl)
        let urls = (try? fm.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        var evicted = 0
        for u in urls where Self.recognizedExtensions.contains(u.pathExtension) {
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
        for u in urls where Self.recognizedExtensions.contains(u.pathExtension) {
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

    // MARK: - lastKnownETag pointers (per-asset files)

    /// Per-asset pointer files live at
    /// `<cacheDir>/etag-pointers/<sha1(assetID)>.txt` and contain just
    /// the asset's last-observed ETag. Distinct assetIDs map to
    /// distinct paths, so concurrent writers for different assets
    /// never collide — no inter-process coordination needed for the
    /// dict-replacement layer. Eviction is oldest-by-mtime when the
    /// pointer count exceeds `etagDictCap`, mirroring the pattern the
    /// AVIF bytes cache already uses.
    private func pointerURL(assetID: String) -> URL? {
        guard let pdir = pointersDir else { return nil }
        let digest = Insecure.SHA1.hash(data: Data(assetID.utf8))
        let name = digest.map { String(format: "%02x", $0) }.joined()
        return pdir.appendingPathComponent("\(name).txt")
    }

    private func loadETag(assetID: String) -> String? {
        guard let url = pointerURL(assetID: assetID),
              let data = try? Data(contentsOf: url),
              let s = String(data: data, encoding: .utf8) else {
            return nil
        }
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func saveETag(assetID: String, etag: String) {
        guard let url = pointerURL(assetID: assetID) else { return }
        let payload = Data(etag.utf8)
        do {
            try payload.write(to: url, options: .atomic)
        } catch {
            log.notice("pointer write failed for \(assetID, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return
        }
        evictPointersIfNeeded()
    }

    /// LRU-by-mtime eviction once the pointer file count exceeds
    /// `etagDictCap`. The pointer dir is small (~28 bytes per file ×
    /// 1024 entries ≈ 30 KB) so this directory walk is cheap.
    private func evictPointersIfNeeded() {
        guard let pdir = pointersDir else { return }
        let urls = (try? fm.contentsOfDirectory(
            at: pdir,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        let pointers = urls.filter { $0.pathExtension == "txt" }
        guard pointers.count > etagDictCap else { return }
        struct Entry { let url: URL; let mtime: Date }
        var entries: [Entry] = []
        for u in pointers {
            let vals = try? u.resourceValues(forKeys: [.contentModificationDateKey])
            entries.append(Entry(url: u, mtime: vals?.contentModificationDate ?? .distantPast))
        }
        entries.sort { $0.mtime < $1.mtime }
        let surplus = entries.count - etagDictCap
        for e in entries.prefix(surplus) {
            try? fm.removeItem(at: e.url)
        }
    }

    // MARK: - Hash

    /// SHA-1 of the ETag, hex-encoded, first 8 bytes = 16 hex chars.
    /// ETags include quotes and special characters; hashing keeps the
    /// filename safe and short. SHA-1 is fine here — collision risk is
    /// "two ETag strings happen to hash the same, second one orphans
    /// the first on disk", which is non-malicious and self-healing on
    /// next fetch.
    private func etagHash(_ etag: String) -> String {
        let digest = Insecure.SHA1.hash(data: Data(etag.utf8))
        return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    }
}
