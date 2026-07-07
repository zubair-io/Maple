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
///
/// Bookmark options differ per platform: macOS needs `.withSecurityScope` to
/// persist folder access across launches; on iOS, security scope is implicit
/// for URLs returned by `UIDocumentPicker` and the option is unavailable.
public actor FilesystemSource {

    // MARK: Platform-specific bookmark options

    #if os(macOS)
    private static let bookmarkCreationOptions: URL.BookmarkCreationOptions = .withSecurityScope
    private static let bookmarkResolutionOptions: URL.BookmarkResolutionOptions = .withSecurityScope
    #else
    private static let bookmarkCreationOptions: URL.BookmarkCreationOptions = []
    private static let bookmarkResolutionOptions: URL.BookmarkResolutionOptions = []
    #endif

    // MARK: Types

    /// A discovered RAW asset on the local filesystem.
    public struct FileAsset: Sendable, Identifiable, Hashable {
        public let id: UUID
        public let url: URL
        public var name: String { url.deletingPathExtension().lastPathComponent }
        public var sidecarURL: URL { SidecarPath.sidecarURL(for: url) }
        public var isVideo: Bool { SidecarPath.isVideo(url) }

        public init(url: URL) {
            self.id = UUID()
            self.url = url
        }
    }

    // MARK: State

    private var folderURL: URL?
    private var bookmarkData: Data?
    private var _assets: [FileAsset] = []

    /// Bookmark-resolved scoped ancestor URL. Long-lived — we hold the scope
    /// claim for the entire life of the source so detached render / thumbnail
    /// tasks (which run on background priority and outlive the call that
    /// started them) can still read sandboxed files. Only released in
    /// `close()` / `deinit`.
    ///
    /// Plain `URL(fileURLWithPath:)` URLs are NOT scope-backed on macOS —
    /// `startAccessingSecurityScopedResource` silently no-ops. Only URLs
    /// returned from `URL(resolvingBookmarkData:)` carry a scope token.
    private var scopeURL: URL?
    private var scopeClaimed: Bool = false

    public var assets: [FileAsset] { _assets }
    /// Expose the scope-backed ancestor so other parts of the pipeline can
    /// wrap their FFI reads in a `startAccessingSecurityScopedResource`
    /// bracket on the same URL.
    public var scopedAncestor: URL? { scopeURL }

    public init() {}

    // MARK: Public API

    /// Open a folder using a URL (e.g., from NSOpenPanel or fileImporter).
    /// Saves a security-scoped bookmark for re-open without prompts.
    ///
    /// The scope claim is held for the lifetime of the source (see
    /// `scopeURL`) — detached render/thumbnail tasks need the claim to
    /// survive the return of this call.
    public func open(folderURL: URL) throws {
        // Resolve any existing scoped access from a prior folder.
        stopAccess()

        let accessing = folderURL.startAccessingSecurityScopedResource()
        self.folderURL = folderURL
        self.scopeURL = folderURL
        self.scopeClaimed = accessing
        self.bookmarkData = try folderURL.bookmarkData(
            options: Self.bookmarkCreationOptions,
            includingResourceValuesForKeys: nil,
            relativeTo: nil
        )
        try _index()
        // Deliberately DO NOT stopAccessingSecurityScopedResource here — the
        // scope must outlive the index call for later render / thumbnail
        // tasks to succeed. Released in `close()` / `deinit`.
    }

    /// Re-open a previously saved security-scoped bookmark (across launches).
    /// Keeps the scope claim alive for the life of the source.
    public func restore(fromBookmarkData data: Data) throws {
        stopAccess()
        var isStale = false
        let url = try URL(
            resolvingBookmarkData: data,
            options: Self.bookmarkResolutionOptions,
            relativeTo: nil,
            bookmarkDataIsStale: &isStale
        )
        let accessing = url.startAccessingSecurityScopedResource()
        self.folderURL = url
        self.scopeURL = url
        self.scopeClaimed = accessing
        self.bookmarkData = isStale
            ? try url.bookmarkData(options: Self.bookmarkCreationOptions, includingResourceValuesForKeys: nil, relativeTo: nil)
            : data
        try _index()
        // Keep scope open — see `open(folderURL:)` for rationale.
    }

    /// The bookmark data to persist (save to UserDefaults / app state).
    public var persistableBookmark: Data? { bookmarkData }

    /// Release the long-lived scope claim. Called from `deinit` implicitly,
    /// or explicitly when the source is rotated out of `BrowseViewModel`.
    public func close() {
        stopAccess()
        folderURL = nil
        scopeURL = nil
        bookmarkData = nil
        _assets = []
    }

    /// Stop accessing the security-scoped resource, if we've been holding
    /// one. Safe to call redundantly.
    public func stopAccess() {
        if scopeClaimed, let url = scopeURL {
            url.stopAccessingSecurityScopedResource()
            scopeClaimed = false
        }
    }

    /// Return the bookmark-resolved ancestor URL whose scope covers `url`.
    /// `nil` when `url` lies outside this source's claimed folder.
    ///
    /// Consumers call this to find the right URL to pass to
    /// `startAccessingSecurityScopedResource` before a Rust FFI read —
    /// claiming on a reconstructed `url.deletingLastPathComponent()` is a
    /// silent no-op because that URL carries no scope token.
    public func findScopedParent(for fileURL: URL) -> URL? {
        guard let scope = scopeURL else { return nil }
        if fileURL.path.hasPrefix(scope.path) { return scope }
        return nil
    }

    deinit {
        if scopeClaimed, let url = scopeURL {
            url.stopAccessingSecurityScopedResource()
        }
    }

    // MARK: Private

    /// List RAW files **directly** inside `folderURL` — not recursively.
    /// Browsing is Finder-style: the grid shows only what's at the current
    /// depth and drill-down is a separate action. `FileManager.enumerator`
    /// would walk descendants, flattening every RAW in the tree into one
    /// list; we use `contentsOfDirectory` instead which stops at one level.
    private func _index() throws {
        guard let folder = folderURL else { return }
        // Scope is already claimed in `open(folderURL:)` / `restore(...)` and
        // held for the life of the source — no need to re-bracket here.

        let fm = FileManager.default
        let contents = try fm.contentsOfDirectory(
            at: folder,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        )

        _assets = contents
            .filter { SupportedImageExtensions.all.contains($0.pathExtension.lowercased()) }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .map { FileAsset(url: $0) }
    }
}

// MARK: - ImageSource conformance

extension FilesystemSource: ImageSource {
    /// Map discovered `FileAsset`s to the generic `ImageRef` vocabulary.
    /// The id is the filesystem URL path — stable for the lifetime of the
    /// folder and unique within this source.
    public func images() async throws -> [ImageRef] {
        let scope = scopeURL
        return _assets.map { fa in
            ImageRef(
                id: fa.url.path,
                displayName: fa.name,
                url: fa.url,
                scopeParentURL: scope
            )
        }
    }

    /// Filesystem sources don't synthesise thumbnails; callers fall through
    /// to the Rust decoder's embedded-preview path.
    public func thumb(for ref: ImageRef) async throws -> Data? { nil }

    public func preview(for ref: ImageRef) async throws -> Data? { nil }

    public func rawBytes(for ref: ImageRef) async throws -> Data {
        guard let url = ref.url else {
            throw ImageSourceError.notFound(ref.id)
        }
        // Belt-and-braces: scope is already held on `scopeURL` for the life
        // of this source, so Data(contentsOf:) will succeed without the
        // per-call bracket — but we keep a no-op bracket for parity with
        // other sources.
        let scope = findScopedParent(for: url)
        let accessing = scope?.startAccessingSecurityScopedResource() ?? false
        defer { if accessing { scope?.stopAccessingSecurityScopedResource() } }
        return try Data(contentsOf: url)
    }

    public func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {
        guard let url = ref.url else {
            throw ImageSourceError.notFound(ref.id)
        }
        let sidecarURL = SidecarPath.sidecarURL(for: url)
        let scope = findScopedParent(for: url)
        let accessing = scope?.startAccessingSecurityScopedResource() ?? false
        defer { if accessing { scope?.stopAccessingSecurityScopedResource() } }
        // Atomic temp + replace; matches XMPSidecarStore.writeAtomically.
        let xml = XMPSerializer.serialize(model: sidecar.model, culling: sidecar.culling)
        guard let data = xml.data(using: .utf8) else {
            throw XMPStoreError.encodingError
        }
        let tmpURL = sidecarURL.deletingLastPathComponent()
            .appendingPathComponent(".\(sidecarURL.lastPathComponent).tmp")
        try data.write(to: tmpURL, options: .atomic)
        _ = try FileManager.default.replaceItemAt(sidecarURL, withItemAt: tmpURL)
    }

    /// Filesystem has no index; return `nil` to signal "cannot search".
    public func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }
}

// MARK: - RAWExtensions

public enum RAWExtensions {
    /// Known RAW file extensions (lowercase). Matches spec § 01 inventory.
    public static let all: Set<String> = [
        "dng", "cr2", "cr3", "nef", "nrw",
        "arw", "srf", "sr2", "rw2", "raf",
        "orf", "pef", "dcs", "raw", "rwl",
        "mrw", "erf", "3fr", "fff", "iiq",
        "cap", "tif", "tiff", "srw", "x3f",
        "mef",
    ]
}

// MARK: - NonRawImageExtensions

public enum NonRawImageExtensions {
    /// Known non-RAW image extensions (lowercase). These ship demosaiced
    /// sRGB / Display-P3 pixels with an embedded ICC profile and skip the
    /// rawler decode + DCP / demosaic / WB calibration stages — see
    /// `decodeSceneLinearNonRaw` in EditSession / ImageEditPipeline.
    ///
    /// `tif` / `tiff` are intentionally NOT listed here; they remain in
    /// `RAWExtensions.all` because camera-sourced TIFFs (Phase One IIQ
    /// tethered captures, scientific cameras) carry sensor data that the
    /// Rust pipeline has to demosaic. Plain photographic TIFFs would
    /// route through the RAW path and `rawler` falls back gracefully on
    /// non-Bayer TIFF — the OPEN dispatch is what splits the chain.
    public static let all: Set<String> = [
        "heic", "heif",
        "jpg", "jpeg", "jpe",
        "png",
    ]
}

// MARK: - VideoExtensions

public enum VideoExtensions {
    /// Video container extensions (lowercase, no dot). Delegates to
    /// `SidecarPath.videoExtensions` as the single source of truth.
    public static let all: Set<String> = SidecarPath.videoExtensions
}

// MARK: - SupportedImageExtensions

public enum SupportedImageExtensions {
    /// Union of `RAWExtensions.all` + `NonRawImageExtensions.all` +
    /// `VideoExtensions.all` — what the LISTING phase (folder enumeration,
    /// fileImporter content types, drag-and-drop) accepts. The OPEN phase
    /// still branches on the extension to dispatch to the right decoder;
    /// only the listing gate uses this union.
    public static let all: Set<String> = RAWExtensions.all
        .union(NonRawImageExtensions.all)
        .union(VideoExtensions.all)
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
