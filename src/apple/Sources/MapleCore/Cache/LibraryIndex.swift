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

        public init(name: String, mtime: Date? = nil, size: Int64? = nil,
                    stars: Int = 0, flag: String = "none", thumbnailHash: String? = nil) {
            self.name = name
            self.mtime = mtime
            self.size = size
            self.stars = stars
            self.flag = flag
            self.thumbnailHash = thumbnailHash
        }
    }
}

// MARK: - LibraryIndexStore

/// Actor that manages reading/writing the folder-level LibraryIndex JSON.
public actor LibraryIndexStore {
    private let indexURL: URL
    private var index: LibraryIndex?

    public init(folderURL: URL) {
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
        var entry = index?.entries[name] ?? LibraryIndex.LibraryEntry(name: name)
        entry.stars = culling.stars
        entry.flag = culling.flag.rawValue
        if let mtime { entry.mtime = mtime }
        index?.entries[name] = entry
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
