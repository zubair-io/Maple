// FilesystemSource.swift — security-scoped bookmark folder adapter.
//
// Mac: NSOpenPanel for folder selection.
// iOS: .fileImporter modifier in SwiftUI.
// Both: store a security-scoped bookmark so the app can re-open the folder
// across launches without repeated permission prompts.
//
// Discovery: enumerates RAW extensions per spec § 01; also picks up XMP
// sidecars (stored alongside) and reads/writes them via XMPSidecarStore.

import Foundation

// MARK: - FilesystemSource

/// Manages access to a folder of RAW files via security-scoped bookmarks.
public actor FilesystemSource {

    // MARK: Types

    /// A discovered RAW asset on the local filesystem.
    public struct FileAsset: Sendable, Identifiable, Hashable {
        public let id: UUID
        public let url: URL
        public var name: String { url.deletingPathExtension().lastPathComponent }
        public var sidecarURL: URL { url.deletingPathExtension().appendingPathExtension("xmp") }

        public init(url: URL) {
            self.id = UUID()
            self.url = url
        }
    }

    // MARK: State

    private var folderURL: URL?
    private var bookmarkData: Data?
    private var _assets: [FileAsset] = []

    public var assets: [FileAsset] { _assets }

    // MARK: Public API

    /// Open a folder using a URL (e.g., from NSOpenPanel or fileImporter).
    /// Saves a security-scoped bookmark for re-open without prompts.
    public func open(folderURL: URL) throws {
        // Resolve any existing scoped access
        stopAccess()

        let accessing = folderURL.startAccessingSecurityScopedResource()
        defer { if !accessing { } } // Keep open for indexing below

        self.folderURL = folderURL
        self.bookmarkData = try folderURL.bookmarkData(
            options: .withSecurityScope,
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )
        try _index()
        if accessing { folderURL.stopAccessingSecurityScopedResource() }
    }

    /// Re-open a previously saved security-scoped bookmark (across launches).
    public func restore(fromBookmarkData data: Data) throws {
        stopAccess()
        var isStale = false
        let url = try URL(
            resolvingBookmarkData: data,
            options: .withSecurityScope,
            relativeTo: nil,
            bookmarkDataIsStale: &isStale
        )
        let accessing = url.startAccessingSecurityScopedResource()
        self.folderURL = url
        self.bookmarkData = isStale
            ? try url.bookmarkData(options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil)
            : data
        try _index()
        if accessing { url.stopAccessingSecurityScopedResource() }
    }

    /// The bookmark data to persist (save to UserDefaults / app state).
    public var persistableBookmark: Data? { bookmarkData }

    /// Stop accessing the security-scoped resource.
    public func stopAccess() {
        folderURL?.stopAccessingSecurityScopedResource()
    }

    // MARK: Private

    private func _index() throws {
        guard let folder = folderURL else { return }
        let accessing = folder.startAccessingSecurityScopedResource()
        defer { if accessing { folder.stopAccessingSecurityScopedResource() } }

        let fm = FileManager.default
        guard let enumerator = fm.enumerator(
            at: folder,
            includingPropertiesForKeys: [.isRegularFileKey, .isHiddenKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else { return }

        _assets = []
        for case let url as URL in enumerator {
            let ext = url.pathExtension.lowercased()
            if RAWExtensions.all.contains(ext) {
                _assets.append(FileAsset(url: url))
            }
        }
        _assets.sort { $0.url.lastPathComponent < $1.url.lastPathComponent }
    }
}

// MARK: - RAWExtensions

public enum RAWExtensions {
    /// Known RAW file extensions (lowercase). Matches spec § 01 inventory.
    public static let all: Set<String> = [
        "dng", "cr2", "cr3", "nef", "nrw",
        "arw", "srf", "sr2", "rw2", "raf",
        "orf", "pef", "dcs", "raw", "rwl",
        "mrw", "erf", "3fr", "fff", "iiq",
        "cap", "tif", "tiff",
    ]
}

// MARK: - macOS folder picker helper

#if os(macOS)
import AppKit

extension FilesystemSource {
    /// Present `NSOpenPanel` and return the chosen folder URL. Callable from
    /// any isolation context (e.g. a `.fileImporter` success closure) — the
    /// panel itself is presented inside an explicit `MainActor.run` hop so we
    /// don't have to infect the call site with `@MainActor`.
    public static func presentFolderPicker() async -> URL? {
        await MainActor.run {
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.allowsMultipleSelection = false
            panel.prompt = "Open Folder"
            panel.message = "Choose a folder of RAW files to open in Maple"
            guard panel.runModal() == .OK else { return nil as URL? }
            return panel.url
        }
    }
}
#endif
