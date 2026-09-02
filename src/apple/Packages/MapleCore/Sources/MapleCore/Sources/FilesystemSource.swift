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
import OSLog

/// Shared with `FilesystemSource+ExternalRename.swift` — not file-private,
/// so both files' log lines land under the same category.
let filesystemSourceLog = Logger(subsystem: "app.justmaple.aperture", category: "FilesystemSource")

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
    /// Not file-private — `FilesystemSource+MapleId.swift` reads this.
    var idCache: MapleIdCacheStore?

    /// Live folder-content watcher (#2656) — fires (debounced) whenever a
    /// direct child of the open folder is created, removed, or renamed, so
    /// an external rename made in Finder while Maple is open gets
    /// reconciled without waiting for the next `open()`. `nil` until a
    /// folder is opened/restored, or when `FolderChangeWatcher.init?`
    /// itself fails (best-effort — see its doc comment); reset to `nil` in
    /// `close()`. Not file-private — `FilesystemSource+ExternalRename.swift`
    /// (`startWatchingForExternalChanges` and friends) reads/writes this.
    var changeWatcher: FolderChangeWatcher?

    /// Owned per-folder `LibraryIndex` store (#2656 review — B4). Created
    /// fresh in `open()`/`restore()`, reset to `nil` in `close()`, and
    /// passed into every `ExternalRenameReconciler.reconcile` call for this
    /// folder's lifetime — sharing ONE actor instance serializes every
    /// fingerprint read/write for this folder's reconcile passes through it.
    /// This is no longer load-bearing for correctness against OTHER,
    /// independently-constructed `LibraryIndexStore` instances (e.g. an
    /// ordinary in-app rename's own store) — `LibraryIndexStore` re-reads
    /// `index.json` fresh on every call rather than trusting a cached
    /// snapshot (#2844), so independent instances can no longer clobber each
    /// other's writes. Keeping one shared instance here is still worthwhile:
    /// it narrows the residual TOCTOU window between this folder's own
    /// reconcile-pass reads/writes to zero, and avoids constructing (and
    /// `mkdir`-ing `.maple/`) a fresh actor on every scan.
    private var libraryIndexStore: LibraryIndexStore?

    /// Bumped at the top of every `_index()` call (#2656 review — B3).
    /// `FilesystemSource` is an actor, and `_index()` suspends at its
    /// `await ExternalRenameReconciler.reconcile(...)` call — actor
    /// reentrancy means a SECOND `_index()` (the watcher firing while
    /// `open()`'s own `_index()` is still mid-flight, or two watcher ticks
    /// racing) can start and finish in that gap. Without a check, the first
    /// call resuming afterward would overwrite `_assets` with its own
    /// now-stale listing, silently undoing the fresher scan. Each call
    /// captures its own generation and only writes `_assets` if it's still
    /// the most recent one when it resumes.
    private var indexGeneration: Int = 0

    /// Test seam (#2656 review — B3): when nonzero, `_index()` sleeps this
    /// long right before its generation check / `_assets` write — widens
    /// the reentrancy window `indexGeneration` guards against from
    /// "whatever the real `await` happens to take" to something a test can
    /// control deterministically. Zero (the default) in production: no
    /// delay, no behavior change. `internal`, not `public`.
    var indexTestDelayNanoseconds: UInt64 = 0

    /// Test seam (#2656): overridable so tests can inject deterministic
    /// fingerprints without real EXIF-bearing fixtures on disk — see
    /// `ExternalRenameFingerprint.live`'s doc comment for why the
    /// production default can't be driven from plain temp-dir files.
    /// `internal`, not `public` — production callers always get `.live`.
    var externalRenameFingerprintProvider: @Sendable (URL) -> ExternalRenameFingerprint? = ExternalRenameFingerprint.live

    /// Bytes read per `FallbackFormHasher.update(_:)` call when streaming a
    /// whole file for fallback-form id derivation — bounded so a 100+ MB RAW
    /// is never held in memory as one buffer. 4 MiB balances syscall count
    /// against peak memory; not a tuned constant, just a reasonable bound.
    /// Not file-private — `FilesystemSource+MapleId.swift` reads this.
    static let fallbackHashChunkSize = 4 * 1024 * 1024

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
    public func open(folderURL: URL) async throws {
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
        self.libraryIndexStore = LibraryIndexStore(folderURL: folderURL)
        try await _index()
        startWatchingForExternalChanges(folderURL)
        // Deliberately DO NOT stopAccessingSecurityScopedResource here — the
        // scope must outlive the index call for later render / thumbnail
        // tasks to succeed. Released in `close()` / `deinit`.
    }

    /// Re-open a previously saved security-scoped bookmark (across launches).
    /// Keeps the scope claim alive for the life of the source.
    public func restore(fromBookmarkData data: Data) async throws {
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
        self.libraryIndexStore = LibraryIndexStore(folderURL: url)
        try await _index()
        startWatchingForExternalChanges(url)
        // Keep scope open — see `open(folderURL:)` for rationale.
    }

    /// The bookmark data to persist (save to UserDefaults / app state).
    public var persistableBookmark: Data? { bookmarkData }

    /// Release the long-lived scope claim. Called from `deinit` implicitly,
    /// or explicitly when the source is rotated out of `BrowseViewModel`.
    public func close() {
        stopAccess()
        changeWatcher?.stop()
        changeWatcher = nil
        folderURL = nil
        scopeURL = nil
        bookmarkData = nil
        _assets = []
        idCache = nil
        libraryIndexStore = nil
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

    // MARK: Private (internal for #2656 test seam — see below)

    /// List RAW files **directly** inside `folderURL` — not recursively.
    /// Browsing is Finder-style: the grid shows only what's at the current
    /// depth and drill-down is a separate action. `FileManager.enumerator`
    /// would walk descendants, flattening every RAW in the tree into one
    /// list; we use `contentsOfDirectory` instead which stops at one level.
    ///
    /// Runs `ExternalRenameReconciler` (#2656) against the fresh listing
    /// before rebuilding `_assets` — a same-folder external rename reconciled
    /// here means the sidecar has already followed by the time `_assets`
    /// (and thus `images()`) reflects the new filename.
    ///
    /// Reentrancy-safe (#2656 review — B3): captures its own generation and
    /// only writes `_assets` if it's still the most recent call when it
    /// resumes past the `await` below — see `indexGeneration`'s doc comment.
    ///
    /// `internal`, not `private`: `FilesystemSourceExternalRenameTests`
    /// calls this directly to simulate the watcher's debounced callback
    /// firing (real `DispatchSource` timing is covered separately, and much
    /// more cheaply, by `FolderChangeWatcherTests`).
    func _index() async throws {
        guard let folder = folderURL else { return }
        indexGeneration += 1
        let generation = indexGeneration
        // Scope is already claimed in `open(folderURL:)` / `restore(...)` and
        // held for the life of the source — no need to re-bracket here.

        let fm = FileManager.default
        let contents = try fm.contentsOfDirectory(
            at: folder,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        )
        let imageURLs = contents.filter { SupportedImageExtensions.all.contains($0.pathExtension.lowercased()) }

        if let store = libraryIndexStore {
            await ExternalRenameReconciler.reconcile(
                store: store, folderURL: folder, currentFiles: imageURLs,
                fingerprintProvider: externalRenameFingerprintProvider)
        }

        if indexTestDelayNanoseconds > 0 {
            try? await Task.sleep(nanoseconds: indexTestDelayNanoseconds)
        }

        // A newer `_index()` call already completed and wrote `_assets`
        // while this one was suspended above — drop this stale write rather
        // than clobber the fresher result.
        guard generation == indexGeneration else { return }
        _assets = imageURLs
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .map { FileAsset(url: $0) }
    }

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
        // #2274 (unified Timeline Phase 2): local-folder assets carried no
        // `captureDate`, so `MergedTimelineSource` had nothing to bucket
        // them by and the Timeline section silently excluded every local
        // Folders source. The raw EXIF `DateTimeOriginal` string is already
        // being cached per-file in `LibraryIndex.LibraryEntry
        // .dateTimeOriginal` — `ExternalRenameReconciler.syncFingerprintCache`
        // warms it (incrementally, up to `maxFingerprintWarmupPerScan` files
        // per `_index()` scan) for its OWN purpose (same-folder external-
        // rename detection, #2656), but the cached value is exactly the
        // capture-date input `captureDate` needs too — so this reads that
        // SAME cache rather than re-deriving anything or reading EXIF a
        // second time. `LibraryIndexStore.load()` re-reads `index.json`
        // fresh every call (see its own doc comment on why that's cheap
        // enough not to bother caching further), so this stays correct
        // across concurrent writers without adding a second cache layer.
        let index = try? await libraryIndexStore?.load()
        var refs: [ImageRef] = []
        refs.reserveCapacity(_assets.count)
        for fa in _assets {
            let id = await mapleId(for: fa) ?? fa.url.path
            let captureDate = index?.entries[fa.url.lastPathComponent]?.dateTimeOriginal
                .flatMap { ExifCaptureDate.iso8601UTC(fromExifString: $0) }
                .flatMap { ISO8601FlexibleDateDecoding.date(from: $0) }
            refs.append(ImageRef(
                id: id,
                displayName: fa.name,
                url: fa.url,
                scopeParentURL: scope,
                captureDate: captureDate
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
    ///
    /// `seedDirectory` seeds `NSOpenPanel.directoryURL` — used by the
    /// drop-to-mount flow (#2649) to open the panel already pointed at the
    /// folder the user just dropped something from, rather than wherever
    /// the panel last was. `prompt`/`message` let that same caller explain
    /// WHY it's asking (macOS grants a sandboxed app scope on the exact
    /// item a Finder drag carries, never that item's parent directory — so
    /// enumerating the parent needs an explicit, separate user grant; no
    /// code path around that exists).
    public static func presentFolderPicker(
        seedDirectory: URL? = nil,
        prompt: String = "Open Folder",
        message: String = "Choose a folder of RAW files to open in Maple"
    ) async -> URL? {
        await MainActor.run {
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.allowsMultipleSelection = false
            panel.prompt = prompt
            panel.message = message
            if let seedDirectory {
                panel.directoryURL = seedDirectory
            }
            guard panel.runModal() == .OK else { return nil as URL? }
            return panel.url
        }
    }
}
#endif
