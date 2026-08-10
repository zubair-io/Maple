// LibraryIndex.swift — Per-folder JSON cache for cold-open performance.
//
// Stores: file list, mtime map, culling state map, thumbnail hash map.
// Saved to .maple/index.json — same location read by Maple Hosted / Self Hosted.
// Updated incrementally on every culling change via XMPSidecarStore.

import Foundation

// MARK: - LibraryIndex

public struct LibraryIndex: Codable, Sendable {
    public var version: Int = 1
    public var folderURL: String
    public var entries: [String: LibraryEntry]  // key = lastPathComponent (filename)
    public var lastUpdated: Date

    public init(folderURL: URL) {
        self.folderURL = folderURL.path
        self.entries = [:]
        self.lastUpdated = Date()
    }

    // MARK: - LibraryEntry

    public struct LibraryEntry: Codable, Sendable {
        public var name: String
        public var mtime: Date?
        public var size: Int64?
        public var stars: Int
        public var flag: String  // "none" | "pick" | "reject"
        public var thumbnailHash: String?
        /// Cheap external-rename fingerprint (issue #2656) — EXIF
        /// `DateTimeOriginal` + (when the camera writes one) body serial
        /// number, captured the last time this file was successfully
        /// fingerprinted. Both `nil` for entries never fingerprinted (older
        /// index files decode these as `nil` automatically — additive,
        /// non-breaking `Codable` fields) or for files ImageIO can't read
        /// EXIF from at all. `ExternalRenameReconciler` requires
        /// `dateTimeOriginal` to consider an entry a rename candidate —
        /// see `ExternalRenameFingerprint`'s doc comment for why a
        /// size-only fallback is never acceptable.
        public var dateTimeOriginal: String?
        public var cameraSerial: String?

        public init(name: String, mtime: Date? = nil, size: Int64? = nil,
                    stars: Int = 0, flag: String = "none", thumbnailHash: String? = nil,
                    dateTimeOriginal: String? = nil, cameraSerial: String? = nil) {
            self.name = name
            self.mtime = mtime
            self.size = size
            self.stars = stars
            self.flag = flag
            self.thumbnailHash = thumbnailHash
            self.dateTimeOriginal = dateTimeOriginal
            self.cameraSerial = cameraSerial
        }
    }
}

// MARK: - LibraryIndexStore

/// Actor that manages reading/writing the folder-level LibraryIndex JSON.
public actor LibraryIndexStore {
    private let folderURL: URL
    private let indexURL: URL
    private var index: LibraryIndex?

    public init(folderURL: URL) {
        self.folderURL = folderURL
        let mapleDir = folderURL.appendingPathComponent(".maple")
        self.indexURL = mapleDir.appendingPathComponent("index.json")
        try? FileManager.default.createDirectory(at: mapleDir, withIntermediateDirectories: true)
    }

    // MARK: - Load

    public func load() throws -> LibraryIndex? {
        if let cached = index { return cached }
        guard FileManager.default.fileExists(atPath: indexURL.path) else { return nil }
        let data = try Data(contentsOf: indexURL)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let loaded = try decoder.decode(LibraryIndex.self, from: data)
        index = loaded
        return loaded
    }

    // MARK: - Update entry

    public func updateEntry(name: String, culling: CullingState, mtime: Date? = nil) throws {
        if index == nil { _ = try? load() }
        // A folder with no `index.json` yet (never browsed/culled before,
        // or its whole entry set was just relocated away) has no index to
        // load — without this, `index` stays nil and the write below
        // silently no-ops (both `index?.entries[...] =` and `save()`'s
        // `guard var idx = index else { return }` are no-ops on nil).
        if index == nil { index = LibraryIndex(folderURL: folderURL) }
        var entry = index?.entries[name] ?? LibraryIndex.LibraryEntry(name: name)
        entry.stars = culling.stars
        entry.flag = culling.flag.rawValue
        if let mtime { entry.mtime = mtime }
        index?.entries[name] = entry
        try save()
    }

    // MARK: - Update fingerprints, batched (#2656)

    /// One file's cheap external-rename fingerprint, as recorded by
    /// `updateFingerprints(_:)`.
    public struct FingerprintUpdate: Sendable {
        public let name: String
        public let size: Int64?
        public let mtime: Date?
        public let dateTimeOriginal: String?
        public let cameraSerial: String?

        public init(name: String, size: Int64?, mtime: Date?, dateTimeOriginal: String?, cameraSerial: String?) {
            self.name = name
            self.size = size
            self.mtime = mtime
            self.dateTimeOriginal = dateTimeOriginal
            self.cameraSerial = cameraSerial
        }
    }

    /// Record every fingerprint in `updates` (size, mtime, EXIF
    /// `DateTimeOriginal`, camera serial) without touching culling state,
    /// in exactly ONE `save()` — a single atomic JSON rewrite regardless of
    /// how many files are being warmed. `ExternalRenameReconciler` calls
    /// this once per folder scan so a LATER scan (after a file has vanished,
    /// renamed away by Finder) still has something to match a newly-appeared
    /// file against.
    ///
    /// A prior per-file `updateFingerprint` (one `save()` each) meant the
    /// first scan of an N-file folder paid N full-JSON atomic rewrites in a
    /// row, serialized through this actor, for a scan that usually has
    /// nothing to reconcile — real cost on a large library with no benefit.
    /// Batching collapses that to one write no matter how many entries
    /// changed. Creates an entry for any `name` not already present, exactly
    /// like `updateEntry`. A no-op (no `save()` at all) for an empty array.
    public func updateFingerprints(_ updates: [FingerprintUpdate]) throws {
        guard !updates.isEmpty else { return }
        if index == nil { _ = try? load() }
        if index == nil { index = LibraryIndex(folderURL: folderURL) }
        for update in updates {
            var entry = index?.entries[update.name] ?? LibraryIndex.LibraryEntry(name: update.name)
            entry.size = update.size
            entry.mtime = update.mtime
            entry.dateTimeOriginal = update.dateTimeOriginal
            entry.cameraSerial = update.cameraSerial
            index?.entries[update.name] = entry
        }
        try save()
    }

    // MARK: - Remove entry

    /// Drop `name`'s entry, if any (issue #2631: after a relocate moves a
    /// file out of this folder, its old entry here is stale — filename keys
    /// aren't repointed, only removed/re-added). A no-op when there's no
    /// index on disk yet or the name was never present.
    public func removeEntry(named name: String) throws {
        if index == nil { _ = try? load() }
        guard index != nil else { return }
        index?.entries.removeValue(forKey: name)
        try save()
    }

    // MARK: - Rebuild

    public func rebuild(from assets: [URL]) throws {
        var idx = LibraryIndex(folderURL: URL(fileURLWithPath: index?.folderURL ?? ""))
        let fm = FileManager.default
        for url in assets {
            let name = url.lastPathComponent
            let attrs = try? fm.attributesOfItem(atPath: url.path)
            let mtime = attrs?[.modificationDate] as? Date
            let size = attrs?[.size] as? Int64
            idx.entries[name] = LibraryIndex.LibraryEntry(
                name: name, mtime: mtime, size: size
            )
        }
        index = idx
        try save()
    }

    // MARK: - Save

    private func save() throws {
        guard var idx = index else { return }
        idx.lastUpdated = Date()
        index = idx
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(idx)
        try data.write(to: indexURL, options: .atomic)
    }
}
