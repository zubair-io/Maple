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

    /// Per-folder maple_id cache (#1995) — avoids re-hashing every file on
    /// every browse. `nil` until a folder is opened/restored; reset to
    /// `nil` in `close()`. See `MapleIdCache.swift` for the multi-writer
    /// design.
    private var idCache: MapleIdCacheStore?

    /// Bytes read per `FallbackFormHasher.update(_:)` call when streaming a
    /// whole file for fallback-form id derivation — bounded so a 100+ MB RAW
    /// is never held in memory as one buffer. 4 MiB balances syscall count
    /// against peak memory; not a tuned constant, just a reasonable bound.
    private static let fallbackHashChunkSize = 4 * 1024 * 1024

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
        self.idCache = MapleIdCacheStore(folderURL: folderURL)
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
        self.idCache = MapleIdCacheStore(folderURL: url)
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
        idCache = nil
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

    // MARK: - maple_id derivation (#1995)

    /// Resolve a maple_id for `asset`, consulting the folder's id-cache
    /// first (`MapleIdCacheStore.lookup`) and only re-deriving (then
    /// persisting) on a cache miss or a stale entry (size/mtime mismatch —
    /// the file was replaced at this path since the id was last computed).
    /// Returns `nil` when the file's attributes can't be read or derivation
    /// itself fails; `images()` falls back to the file path in that case.
    private func mapleId(for asset: FileAsset) async -> String? {
        guard let idCache else { return nil }
        // `FileManager.attributesOfItem(atPath:)`, NOT `URL.resourceValues
        // (forKeys:)` — `URL` caches fetched resource values on the URL
        // value itself, so re-querying the SAME `FileAsset.url` (stored once
        // in `_assets`, reused across every `images()` call) after the file
        // changed on disk can silently return the FIRST call's stale
        // snapshot instead of a fresh stat(). `attributesOfItem(atPath:)`
        // has no such cache — every call is a real stat(2).
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: asset.url.path),
              let size = (attrs[.size] as? NSNumber)?.int64Value,
              let modDate = attrs[.modificationDate] as? Date
        else { return nil }

        let sizeI64 = size
        let mtime = modDate.timeIntervalSince1970
        // Non-recursive listing (`_index()`) means every asset's filename is
        // already a stable, unambiguous key within this folder — no need
        // for the full absolute path.
        let cacheKey = asset.url.lastPathComponent

        if let cached = await idCache.lookup(path: cacheKey, size: sizeI64, mtime: mtime) {
            return cached
        }
        guard let derived = await deriveMapleId(for: asset, filesize: sizeI64) else { return nil }
        await idCache.record(path: cacheKey, mapleId: derived, size: sizeI64, mtime: mtime)
        return derived
    }

    /// Derive a maple_id from scratch: read the first 64 KB + raw EXIF
    /// capture-date strings for the primary-form attempt, and hand a
    /// chunked `FileHandle` reader to `MapleIdDerivation.derive` for the
    /// fallback-form path so a large RAW is never held in memory as one
    /// buffer.
    private func deriveMapleId(for asset: FileAsset, filesize: Int64) async -> String? {
        guard let handle = try? FileHandle(forReadingFrom: asset.url) else { return nil }
        defer { try? handle.close() }

        let headBytes = (try? handle.read(upToCount: Self.mapleIdHeadByteCount)) ?? Data()
        let dates = ImageMetadataReader.readRawCaptureDateStrings(from: asset.url)
        // Rewind — the head read above consumed the handle's offset, and
        // the fallback-form path (if reached) needs the WHOLE file from
        // byte 0, head bytes included. A silently-swallowed seek failure
        // here would corrupt the fallback-form hash (missing its first 64
        // KB) without any signal, so this checks explicitly rather than
        // `try?`-and-proceed.
        do {
            try handle.seek(toOffset: 0)
        } catch {
            return nil
        }

        // `try` (not `try?`) inside the closure: a transient
        // `FileHandle.read` error must reach `derive`'s `rethrows`
        // propagation, not collapse to empty `Data` — which `derive`'s loop
        // reads as EOF, silently hashing only a prefix of the file into a
        // wrong fallback-form id. `derive`'s own `try?` at this call site
        // catches that (and any other) thrown error and collapses it to
        // `nil`, matching this function's established fail-safe-to-nil
        // contract (mirrors `SMBSource.deriveMapleId`'s identical
        // throw-then-`try?` shape for the same reason).
        return try? await MapleIdDerivation.derive(
            headBytes: headBytes,
            exifDateTimeOriginal: dates.dateTimeOriginal,
            exifCreateDate: dates.createDate,
            filesize: UInt64(filesize),
            nextChunk: {
                try handle.read(upToCount: Self.fallbackHashChunkSize) ?? Data()
            }
        )
    }

    /// First 64 KB of a file — the bound the primary-form head hash reads.
    /// Matches `raw_core::SHA1_HEAD_BYTES` (`id.rs`); duplicated as a literal
    /// rather than threaded across the FFI boundary for a single integer —
    /// `MapleId.primary` ignores anything past this bound regardless of how
    /// much the caller hands it, so reading more here would just waste I/O.
    fileprivate static let mapleIdHeadByteCount = 64 * 1024
}

// MARK: - ImageSource conformance

extension FilesystemSource: ImageSource {
    /// Map discovered `FileAsset`s to the generic `ImageRef` vocabulary.
    /// `id` is the spec-form `maple_id` hex (#1995) — a content-addressed,
    /// BLAKE3-based id shared with the server's indexer and Web, so the same
    /// photo resolves to the same cache key regardless of which platform
    /// derived it. Falls back to the file's path (the old behaviour) only
    /// when derivation genuinely fails (unreadable file) — this keeps
    /// `images()` from ever losing an asset outright over a hashing error.
    public func images() async throws -> [ImageRef] {
        let scope = scopeURL
        var refs: [ImageRef] = []
        refs.reserveCapacity(_assets.count)
        for fa in _assets {
            let id = await mapleId(for: fa) ?? fa.url.path
            refs.append(ImageRef(
                id: id,
                displayName: fa.name,
                url: fa.url,
                scopeParentURL: scope
            ))
        }
        return refs
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

// MARK: - StubExtensions

/// Image-like formats with no realistic decode path today (epic #1831,
/// ticket #1835): `eip` (Phase One — no rawler support), `braw` (Blackmagic
/// RAW — proprietary SDK-gated, no open decoder), `afphoto` (Affinity Photo
/// — no public spec), `ai` (Illustrator — a PDF/vector container, not a
/// raster image). Mirrors the API's `STUB_IMAGE_EXTS` in
/// `src/api/src/indexer/media-types.ts`. These are indexer-eligible
/// metadata-only stubs: filename/size/date are shown in the grid, but there
/// is no thumbnail, preview, or RAW/non-RAW decode attempt.
public enum StubExtensions {
    public static let all: Set<String> = ["eip", "braw", "afphoto", "ai"]
}

// MARK: - AudioExtensions

/// Audio formats — a wholly new asset category for Maple (epic #1831,
/// ticket #1835). Mirrors the API's `AUDIO_EXTS` in
/// `src/api/src/indexer/media-types.ts`. Indexed as metadata-only stubs: no
/// thumbnail, no decode attempt, but visible in the grid with filename/size/
/// date.
public enum AudioExtensions {
    public static let all: Set<String> = ["mp3", "wav", "m4a", "aac"]
}

// MARK: - SupportedImageExtensions

public enum SupportedImageExtensions {
    /// Union of `RAWExtensions.all` + `NonRawImageExtensions.all` +
    /// `VideoExtensions.all` + `StubExtensions.all` + `AudioExtensions.all`
    /// — what the LISTING phase (folder enumeration, fileImporter content
    /// types, drag-and-drop) accepts. The OPEN phase still branches on the
    /// extension to dispatch to the right decoder (or no-op for stub/audio/
    /// video); only the listing gate uses this union.
    public static let all: Set<String> = RAWExtensions.all
        .union(NonRawImageExtensions.all)
        .union(VideoExtensions.all)
        .union(StubExtensions.all)
        .union(AudioExtensions.all)
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
