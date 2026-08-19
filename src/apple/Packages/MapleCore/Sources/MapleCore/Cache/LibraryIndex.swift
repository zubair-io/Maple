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
        /// `true` when a fingerprint read was actually attempted for this
        /// file at its CURRENT `size`/`mtime` — including an attempt that
        /// came back with no EXIF at all (a PNG screenshot, a video, a
        /// corrupt RAW). Distinguishes "we tried and there's genuinely
        /// nothing to fingerprint" from "never attempted" — without this,
        /// an EXIF-less file has `dateTimeOriginal == nil` either way, so
        /// `syncFingerprintCache`'s freshness check (keyed only on
        /// `dateTimeOriginal != nil`) could never recognize "already tried,
        /// don't bother again," and paid a full `ImageIO` read for that
        /// file on EVERY single scan for as long as it sat in the folder.
        /// `nil` for entries written before this field existed — additive,
        /// non-breaking `Codable` field, decodes as `nil` on older
        /// `index.json` files, treated the same as `false`.
        public var fingerprintAttempted: Bool?

        public init(name: String, mtime: Date? = nil, size: Int64? = nil,
                    stars: Int = 0, flag: String = "none", thumbnailHash: String? = nil,
                    dateTimeOriginal: String? = nil, cameraSerial: String? = nil,
                    fingerprintAttempted: Bool? = nil) {
            self.name = name
            self.mtime = mtime
            self.size = size
            self.stars = stars
            self.flag = flag
            self.thumbnailHash = thumbnailHash
            self.dateTimeOriginal = dateTimeOriginal
            self.cameraSerial = cameraSerial
            self.fingerprintAttempted = fingerprintAttempted
        }
    }
}

// MARK: - Date coding

extension JSONEncoder {
    static var libraryIndexEncoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }
}

extension JSONDecoder {
    static var libraryIndexDecoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

// MARK: - LibraryIndexStore

/// Actor that manages reading/writing the folder-level LibraryIndex JSON.
///
/// Deliberately holds NO in-memory snapshot between calls (#2844): an
/// earlier version cached the decoded index on first `load()` and reused it
/// forever, on the (false) assumption that this instance is the only writer
/// of `index.json`. It isn't — `LocalFileOperations` constructs a fresh
/// `LibraryIndexStore` on most mutation paths (see
/// `LocalFileOperations+CacheAndIndex.swift`'s `refreshLibraryIndexAfterMove`),
/// so two independent instances routinely exist over the same folder. A
/// cached snapshot in one goes stale the instant the OTHER writes, and the
/// stale instance's next `save()` (a full-object overwrite from that cache)
/// silently discards the other's write — the "last save wins, forgets the
/// interleaved writer" bug from #2844. Every method below re-reads
/// `index.json` fresh and folds its own change into THAT read before
/// writing, so an independent instance's write in between is always picked
/// up rather than clobbered. This doesn't make two instances' writes
/// atomic against each other (a genuinely simultaneous read-modify-write
/// from both could still race), but it eliminates the actual bug: every
/// call site in this codebase is sequential — one save completes, and only
/// later does the debounced watcher tick's reconcile pass read and save
/// again — so "read fresh right before writing" is sufficient for every
/// real interleaving here. The index is one small JSON file per folder, so
/// re-reading it on every call costs nothing worth caching against.
public actor LibraryIndexStore {
    private let folderURL: URL
    private let indexURL: URL

    public init(folderURL: URL) {
        self.folderURL = folderURL
        let mapleDir = folderURL.appendingPathComponent(".maple")
        self.indexURL = mapleDir.appendingPathComponent("index.json")
        try? FileManager.default.createDirectory(at: mapleDir, withIntermediateDirectories: true)
    }

    // MARK: - Load

    /// Reads `index.json` fresh from disk every time — see the type's doc
    /// comment for why this store never trusts an in-memory snapshot across
    /// calls.
    public func load() throws -> LibraryIndex? {
        guard FileManager.default.fileExists(atPath: indexURL.path) else { return nil }
        let data = try Data(contentsOf: indexURL)
        return try JSONDecoder.libraryIndexDecoder.decode(LibraryIndex.self, from: data)
    }

    // MARK: - Update entry

    public func updateEntry(name: String, culling: CullingState, mtime: Date? = nil) throws {
        // A folder with no `index.json` yet (never browsed/culled before,
        // or its whole entry set was just relocated away) has no index to
        // load — fall back to a fresh one rather than no-op the write.
        var idx = (try? load()) ?? LibraryIndex(folderURL: folderURL)
        var entry = idx.entries[name] ?? LibraryIndex.LibraryEntry(name: name)
        entry.stars = culling.stars
        entry.flag = culling.flag.rawValue
        if let mtime { entry.mtime = mtime }
        idx.entries[name] = entry
        try save(idx)
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
        var idx = (try? load()) ?? LibraryIndex(folderURL: folderURL)
        for update in updates {
            var entry = idx.entries[update.name] ?? LibraryIndex.LibraryEntry(name: update.name)
            entry.size = update.size
            entry.mtime = update.mtime
            entry.dateTimeOriginal = update.dateTimeOriginal
            entry.cameraSerial = update.cameraSerial
            // Every call into this method represents a real attempt (success
            // or not) at `update.size`/`update.mtime` — see
            // `fingerprintAttempted`'s doc comment.
            entry.fingerprintAttempted = true
            idx.entries[update.name] = entry
        }
        try save(idx)
    }

    // MARK: - Remove entry

    /// Drop `name`'s entry, if any (issue #2631: after a relocate moves a
    /// file out of this folder, its old entry here is stale — filename keys
    /// aren't repointed, only removed/re-added). A no-op when there's no
    /// index on disk yet or the name was never present.
    public func removeEntry(named name: String) throws {
        guard var idx = try load() else { return }
        idx.entries.removeValue(forKey: name)
        try save(idx)
    }

    // MARK: - Rebuild

    public func rebuild(from assets: [URL]) throws {
        var idx = LibraryIndex(folderURL: folderURL)
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
        try save(idx)
    }

    // MARK: - Save

    private func save(_ idx: LibraryIndex) throws {
        var idx = idx
        idx.lastUpdated = Date()
        let data = try JSONEncoder.libraryIndexEncoder.encode(idx)
        try data.write(to: indexURL, options: .atomic)
    }
}
