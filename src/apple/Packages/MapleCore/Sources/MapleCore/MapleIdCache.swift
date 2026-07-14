// src/apple/Packages/MapleCore/Sources/MapleCore/MapleIdCache.swift
//
// Multi-process-safe local id-cache for a browsed folder (local filesystem
// or SMB share) (#1995). Avoids re-hashing every file on every folder
// browse by persisting (path key, maple_id, size, mtime) rows and
// invalidating a row whenever the live file's size/mtime no longer match
// what was recorded — a file replaced at the same path/name must not
// silently keep yielding the stale id computed for the old content.
//
// # Why per-writer files, not one shared file
//
// The same NAS folder can be browsed by the Mac app AND a browser tab
// (Maple Hosted, running on some other machine on the LAN) at the same
// time. Two independent processes read-modify-writing ONE shared JSON file
// — even with an atomic write per producer — means the second writer's
// write can silently clobber whatever the first writer persisted since the
// second writer's last read: a classic read-modify-write race, and there's
// no cross-process file-locking guaranteed to work on a plain SMB share (no
// `flock` semantics the protocol promises).
//
// Each producer instead owns exactly one file it is the SOLE writer of —
// `id-cache-apple.json` for this Apple app; a hypothetical Web Hosted writer
// would own `id-cache-web.json` — so a writer never has to merge against a
// concurrent writer's in-flight change; every write this store performs is
// a read-modify-write of a file only this process ever touches. Readers
// UNION every `id-cache-*.json` file present in `.maple/`, so a Mac-computed
// id becomes visible to Web (and vice versa) on the next browse, without
// either side needing distributed locking.
//
// This is deliberately NOT a general CRDT/merge algorithm (see CLAUDE.md
// YAGNI) — maple_id is a pure function of file bytes (+ EXIF), so two
// producers hashing the SAME file content always compute the SAME id; there
// is no real value being reconciled, only presence/freshness. The one piece
// of judgment this store makes is which entry to keep when the same path
// key appears, still valid, in more than one producer's file: it keeps
// whichever has the greatest `mtime` (the freshest observation of that
// path). This is a NEW file, not the existing `.maple/index.json` —
// Apple's numeric-versioned-dictionary schema there and Web's
// string-versioned-array schema are structurally incompatible, and
// reconciling them is out of scope for #1995.
//
// # Storage abstraction
//
// `FilesystemSource` and `SMBSource` both need this exact cache — read the
// union, write your own file — but a local folder and a network share need
// entirely different I/O underneath (`FileManager` vs. AMSMB2). Rather than
// duplicate the whole cache/union/merge logic once per source,
// `MapleIdCacheStore` is parameterized over a small `MapleIdCacheStorage`
// backend; `LocalIdCacheStorage` here covers the filesystem case,
// `SMBIdCacheStorage` (defined in `SMBSource.swift`, so this file doesn't
// need to import AMSMB2) covers the SMB case.

import Foundation

// MARK: - MapleIdCacheEntry

/// One cached row: a maple_id computed for the file at `path`, valid only
/// while the live file's `size`/`mtime` still match what was recorded here.
public struct MapleIdCacheEntry: Codable, Sendable, Equatable {
    /// Discovery-scoped key. `FilesystemSource` uses the file's name
    /// relative to the browsed folder (that source lists only the folder's
    /// immediate contents, non-recursively, so the filename alone is
    /// already a stable, unambiguous key); `SMBSource` uses the
    /// share-relative path (the same string already used as
    /// `ImageRef.id`/`SMBAsset.path`).
    public let path: String
    public let mapleId: String
    public let size: Int64
    /// `Date.timeIntervalSince1970`, NOT a `Date` encoded via
    /// `JSONEncoder.dateEncodingStrategy = .iso8601` — `ISO8601DateFormatter`
    /// defaults to whole-second precision, and round-tripping a sub-second
    /// filesystem mtime through it would silently truncate to the second on
    /// every save, turning `isValid` into an always-stale check after the
    /// very first reload. Plain `Double` round-trips through JSON exactly.
    public let mtime: Double

    public init(path: String, mapleId: String, size: Int64, mtime: Double) {
        self.path = path
        self.mapleId = mapleId
        self.size = size
        self.mtime = mtime
    }

    /// Whether this cached row is still valid for a file currently observed
    /// with `size`/`mtime`. A file replaced at the same path (different
    /// content — a different size, or the same size but always a bumped
    /// mtime on any real filesystem or SMB server) fails this check, so
    /// callers re-derive rather than silently reusing the old content's id.
    public func isValid(size: Int64, mtime: Double) -> Bool {
        self.size == size && self.mtime == mtime
    }
}

/// One producer's `.maple/id-cache-<writer>.json` file — the on-disk
/// envelope `MapleIdCacheStore` reads/writes. `version` is unused today
/// (no reader branches on it) but present so a future incompatible schema
/// change has somewhere to signal itself, matching `LibraryIndex`'s
/// existing `version` field convention.
struct MapleIdCacheFile: Codable {
    var version: Int = 1
    var entries: [MapleIdCacheEntry]
}

// MARK: - MapleIdCacheStorage

/// Storage backend `MapleIdCacheStore` reads/writes its `.maple/id-cache-*
/// .json` files through. Two concrete conformers exist: `LocalIdCacheStorage`
/// below (a local folder, `FileManager`-backed) and `SMBIdCacheStorage`
/// (`SMBSource.swift`, AMSMB2-backed). Both operate purely on bare filenames
/// within an implicit `.maple/` directory — the conformer owns path joining
/// and whatever "directory" even means for its transport.
public protocol MapleIdCacheStorage: Sendable {
    /// Ensure the `.maple/` directory exists. Safe to call redundantly (a
    /// "already exists" condition is not an error from the caller's
    /// perspective).
    func ensureDirectory() async

    /// Every bare filename directly inside `.maple/` matching
    /// `id-cache-*.json` (not full paths — the storage owns path joining).
    func listIdCacheFileNames() async -> [String]

    /// Read one `.maple/<name>` file's raw bytes. `nil` when missing or
    /// unreadable — a cache miss, not an error; every caller here treats
    /// "can't read" the same as "empty cache" rather than surfacing a
    /// failure, since a bad/corrupt cache file should degrade to
    /// re-deriving, not break browsing.
    func readIdCacheFile(name: String) async -> Data?

    /// Best-effort replace `.maple/<name>` with `data`. A failed write here
    /// degrades to "this session re-derives ids it could have cached," never
    /// to data loss for the photos themselves — implementations should
    /// swallow their own I/O errors rather than propagate them.
    func writeIdCacheFile(name: String, data: Data) async
}

// MARK: - LocalIdCacheStorage

/// `FileManager`-backed `MapleIdCacheStorage` for a local folder
/// (`FilesystemSource`).
public struct LocalIdCacheStorage: MapleIdCacheStorage {
    private let mapleDir: URL

    public init(folderURL: URL) {
        self.mapleDir = folderURL.appendingPathComponent(".maple")
    }

    public func ensureDirectory() async {
        try? FileManager.default.createDirectory(at: mapleDir, withIntermediateDirectories: true)
    }

    public func listIdCacheFileNames() async -> [String] {
        let files = (try? FileManager.default.contentsOfDirectory(
            at: mapleDir, includingPropertiesForKeys: nil)) ?? []
        return files
            .map { $0.lastPathComponent }
            .filter { $0.hasPrefix("id-cache-") && $0.hasSuffix(".json") }
    }

    public func readIdCacheFile(name: String) async -> Data? {
        try? Data(contentsOf: mapleDir.appendingPathComponent(name))
    }

    public func writeIdCacheFile(name: String, data: Data) async {
        try? data.write(to: mapleDir.appendingPathComponent(name), options: .atomic)
    }
}

// MARK: - MapleIdCacheStore

/// Actor that manages one producer's `.maple/id-cache-<writer>.json` file
/// for a browsed folder, and reads the UNION of every `id-cache-*.json`
/// file present for lookups. See the file-level doc comment above for the
/// multi-writer design rationale.
public actor MapleIdCacheStore {
    private let storage: any MapleIdCacheStorage
    private let ownFileName: String

    /// This writer's own rows, keyed by path. `nil` until first accessed
    /// (`currentOwnEntries()`), then kept in sync with every `record(...)`
    /// call so a `record` never needs to re-read its own file from storage.
    private var ownEntries: [String: MapleIdCacheEntry]?

    /// Union of every `id-cache-*.json` file's rows, keyed by path. `nil`
    /// until the first `lookup`/`record` call forces a storage scan — loaded
    /// lazily and then cached for the life of this actor instance (one
    /// folder-browse session) so a folder of hundreds of assets pays for the
    /// directory scan + JSON parses exactly once, not once per asset.
    private var unionCache: [String: MapleIdCacheEntry]?

    /// `writer` names this producer's own file — `"apple"` for the Apple
    /// app, producing `id-cache-apple.json`. Not hardcoded so tests can
    /// construct a second store with a different `writer` over the same
    /// storage to simulate a second producer.
    public init(storage: any MapleIdCacheStorage, writer: String = "apple") {
        self.storage = storage
        self.ownFileName = "id-cache-\(writer).json"
    }

    /// Convenience initializer for the common case: a local folder
    /// (`FilesystemSource`). SMB callers use the `storage:` initializer
    /// directly with `SMBIdCacheStorage`.
    public init(folderURL: URL, writer: String = "apple") {
        self.init(storage: LocalIdCacheStorage(folderURL: folderURL), writer: writer)
    }

    /// Look up a still-valid cached id for `path` at the given `size`/
    /// `mtime`, checked against the UNION of every producer's cache file
    /// (not just this writer's own — a Web-computed id is just as usable as
    /// an Apple-computed one for the same file). Returns `nil` on a cache
    /// miss OR a stale entry (size/mtime mismatch); callers re-derive in
    /// either case.
    public func lookup(path: String, size: Int64, mtime: Double) async -> String? {
        let union = await currentUnion()
        guard let entry = union[path], entry.isValid(size: size, mtime: mtime) else { return nil }
        return entry.mapleId
    }

    /// Persist a freshly derived id for `path`. Writes ONLY this producer's
    /// own file (read-modify-write of a file no other process ever writes)
    /// — never touches another producer's `id-cache-*.json`.
    public func record(path: String, mapleId: String, size: Int64, mtime: Double) async {
        var own = await currentOwnEntries()
        let entry = MapleIdCacheEntry(path: path, mapleId: mapleId, size: size, mtime: mtime)
        own[path] = entry
        ownEntries = own
        await saveOwn(own)
        // Keep the in-memory union current so a `record` immediately
        // followed by a `lookup` in the same session (common: derive, then
        // re-list) sees the fresh entry without forcing a storage re-scan.
        if unionCache != nil {
            unionCache?[path] = entry
        }
    }

    // MARK: - Private

    private func currentOwnEntries() async -> [String: MapleIdCacheEntry] {
        if let ownEntries { return ownEntries }
        await storage.ensureDirectory()
        let loaded = await Self.loadEntries(named: ownFileName, storage: storage)
        ownEntries = loaded
        return loaded
    }

    private func currentUnion() async -> [String: MapleIdCacheEntry] {
        if let unionCache { return unionCache }
        await storage.ensureDirectory()
        let union = await loadUnionFromStorage()
        unionCache = union
        return union
    }

    /// Union every `id-cache-*.json` file present, preferring (on a
    /// same-path conflict across files) the entry with the greatest
    /// `mtime`. Files are visited in a fixed (sorted-filename) order so a
    /// tie in `mtime` resolves deterministically rather than depending on
    /// storage enumeration order.
    private func loadUnionFromStorage() async -> [String: MapleIdCacheEntry] {
        let names = await storage.listIdCacheFileNames().sorted()
        var union: [String: MapleIdCacheEntry] = [:]
        for name in names {
            let entries = await Self.loadEntries(named: name, storage: storage)
            for entry in entries.values {
                if let existing = union[entry.path], existing.mtime >= entry.mtime {
                    continue
                }
                union[entry.path] = entry
            }
        }
        return union
    }

    private func saveOwn(_ entries: [String: MapleIdCacheEntry]) async {
        let file = MapleIdCacheFile(entries: Array(entries.values))
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(file) else { return }
        await storage.writeIdCacheFile(name: ownFileName, data: data)
    }

    private static func loadEntries(
        named name: String, storage: any MapleIdCacheStorage
    ) async -> [String: MapleIdCacheEntry] {
        guard let data = await storage.readIdCacheFile(name: name) else { return [:] }
        guard let file = try? JSONDecoder().decode(MapleIdCacheFile.self, from: data) else { return [:] }
        return Dictionary(uniqueKeysWithValues: file.entries.map { ($0.path, $0) })
    }
}
