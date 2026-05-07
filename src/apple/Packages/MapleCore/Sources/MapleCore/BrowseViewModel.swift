// BrowseViewModel.swift — observable state for the Browse grid.
//
// Lives in MapleCore per docs/best-practices.md §"Module boundary": no
// business logic in the app target. Observed by SwiftUI through the
// `@Observable` macro; views hold it as `@State` or `@Bindable`.
//
// Folder loads use a generation counter (docs/best-practices.md
// §"Generation counters for async state") so stale writes from a prior
// folder switch cannot overwrite the current UI state.

import Foundation

@MainActor
@Observable
public final class BrowseViewModel {
    public var assets: [AssetRef] = []
    /// Sub-folders directly inside the currently-opened folder. Populated
    /// alongside `assets` by the filesystem `loadFolder(url:)` path so the
    /// explorer can render a Finder-style mix of folders + images at the
    /// current depth. Empty for non-filesystem sources (PhotoKit, SMB,
    /// SelfHosted).
    public var subfolders: [URL] = []
    public var selectedID: AssetRef.ID? = nil
    public var sortOrder: SortOrder = .nameAscending
    /// Non-nil while an async `loadFolder` is in flight.
    public var isLoading: Bool = false
    /// Last load error; views can surface a banner when non-nil.
    public var loadError: Error?
    /// When non-nil the user selected a Photos-library filter but the app
    /// doesn't yet have PhotoKit permission. Views should surface a "Grant
    /// Access" empty state rather than silently loading zero assets.
    public var photosAuthNeeded: Bool = false
    /// The source feeding the grid. Nil until the user picks one.
    /// `@ObservationIgnored` — callers interested in changes should observe
    /// `assets` / `selectedID` which change together with the source.
    @ObservationIgnored public private(set) var currentSource: (any ImageSource)?

    /// Bookmark-resolved ancestor URL that covers the currently-open folder
    /// tree. AppShell sets this before calling `loadFolder(url:)` so each
    /// `AssetRef` synthesised from the filesystem walk can carry the scope
    /// reference through to `ImageEditPipeline` / `ThumbnailLoader` — which
    /// then wrap their Rust FFI reads in a `startAccessingSecurityScopedResource`
    /// bracket on this URL. Without it the claim is a no-op and sandboxed
    /// reads fail with EPERM.
    @ObservationIgnored public var currentScopeRoot: URL?

    public enum SortOrder: Sendable { case nameAscending, nameDescending, dateDescending }

    /// Monotonically increasing load generation. Each `loadFolder` bumps it;
    /// stale in-flight tasks check the captured generation before mutating
    /// `assets` / `selectedID`.
    @ObservationIgnored private var loadGeneration: UInt64 = 0

    public var selectedAsset: AssetRef? {
        assets.first { $0.id == selectedID }
    }

    public init() {}

    public func selectNext() {
        guard let idx = assets.firstIndex(where: { $0.id == selectedID }), idx + 1 < assets.count
        else { selectedID = assets.first?.id; return }
        selectedID = assets[idx + 1].id
    }

    public func selectPrev() {
        guard let idx = assets.firstIndex(where: { $0.id == selectedID }), idx > 0
        else { selectedID = assets.last?.id; return }
        selectedID = assets[idx - 1].id
    }

    // MARK: - Folder loading

    /// Synchronously list the RAW files in a folder and replace `assets`.
    /// Used when the caller already has main-thread access to the folder
    /// (e.g. the `fileImporter` success case).
    public func loadFolder(url: URL) {
        loadGeneration &+= 1
        let gen = loadGeneration

        let fm = FileManager.default
        guard let contents = try? fm.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            loadError = CocoaError(.fileReadUnknown)
            return
        }
        guard gen == loadGeneration else { return }

        // Partition into sub-folders (minus dotfolders like .maple/) and RAW
        // files at this depth only. Grandchildren are NOT walked — the user
        // drills down by clicking a sub-folder which triggers another
        // `loadFolder(url:)`.
        var subs: [URL] = []
        var raws: [URL] = []
        for entry in contents {
            if entry.lastPathComponent.hasPrefix(".") { continue }
            let isDir = (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
            if isDir {
                subs.append(entry)
            } else if SupportedImageExtensions.all.contains(entry.pathExtension.lowercased()) {
                raws.append(entry)
            }
        }
        subs.sort { $0.lastPathComponent < $1.lastPathComponent }
        raws.sort { $0.lastPathComponent < $1.lastPathComponent }
        // Stamp each AssetRef with the scope root AppShell set before the
        // walk. If nothing's been set we fall back to the folder URL itself
        // — better than nothing when the folder came from `fileImporter` and
        // is already scope-backed.
        let scope = currentScopeRoot ?? url
        let refs = raws.map { AssetRef(url: $0, scopeParentURL: scope) }

        guard gen == loadGeneration else { return }
        assets = refs
        subfolders = subs
        // Don't auto-select the first image — the user should see the whole
        // folder contents first. Selection (highlight) happens on click; the
        // editor only opens on double-click.
        selectedID = nil
        loadError = nil
    }

    /// Async variant that delegates directory enumeration to a `FilesystemSource`
    /// actor. Each `await` is followed by a generation check so that a folder
    /// switch mid-load cannot overwrite the newer selection.
    public func loadFolder(_ folderURL: URL, via source: FilesystemSource) async {
        loadGeneration &+= 1
        let gen = loadGeneration
        isLoading = true
        defer {
            if gen == loadGeneration { isLoading = false }
        }

        do {
            try await source.open(folderURL: folderURL)
            guard gen == loadGeneration else { return }   // user switched folders

            let fileAssets = await source.assets
            guard gen == loadGeneration else { return }

            // The source holds the scope-backed ancestor URL; propagate it
            // to each AssetRef so downstream FFI reads can re-claim scope
            // on the right URL.
            let scope = await source.scopedAncestor
            let refs = fileAssets.map { AssetRef(url: $0.url, scopeParentURL: scope) }
            guard gen == loadGeneration else { return }

            assets = refs
            selectedID = refs.first?.id
            currentSource = source
            loadError = nil
        } catch {
            guard gen == loadGeneration else { return }
            loadError = error
        }
    }

    /// Source-agnostic loader. Works for any `ImageSource` implementation
    /// (Filesystem, PhotoKit, SMB, SelfHosted). `ImageRef.url` maps to an
    /// `AssetRef` when the source is file-shaped; sources without a URL
    /// (PhotoKit, SelfHosted) build a bytes-provider-backed AssetRef that
    /// calls `source.rawBytes(for:)` on demand — no synthetic URL kludge.
    public func loadSource(_ source: any ImageSource) async {
        loadGeneration &+= 1
        let gen = loadGeneration
        isLoading = true
        defer {
            if gen == loadGeneration { isLoading = false }
        }

        do {
            let refs = try await source.images()
            guard gen == loadGeneration else { return }

            let assetRefs = refs.map { ref -> AssetRef in
                if let url = ref.url {
                    return AssetRef(url: url, scopeParentURL: ref.scopeParentURL)
                }
                // Sourceless asset — build a bytes-backed ref. The closure
                // captures the source actor and the stable ref so the Rust
                // pipeline can request bytes at decode time.
                let capturedRef = ref
                let capturedSource = source
                let displayName = ref.displayName
                // Best-effort extension hint from the display name.
                let ext = (ref.displayName as NSString).pathExtension.lowercased()
                return AssetRef(
                    displayName: displayName,
                    hintExtension: ext.isEmpty ? nil : ext,
                    stableID: capturedRef.id,
                    bytesProvider: { [capturedSource, capturedRef] in
                        try await capturedSource.rawBytes(for: capturedRef)
                    }
                )
            }
            guard gen == loadGeneration else { return }

            assets = assetRefs
            subfolders = []
            selectedID = nil
            currentSource = source
            loadError = nil
            photosAuthNeeded = false
        } catch {
            guard gen == loadGeneration else { return }
            loadError = error
        }
    }

    /// Empty the grid and forget the current source. Used when the shell
    /// switches into a mode that doesn't have a source attached yet (e.g.
    /// Maple Cloud Timeline mode in Phase 2 — placeholder until Phase 3
    /// wires up the native timeline view).
    public func clear() {
        loadGeneration &+= 1
        assets = []
        subfolders = []
        selectedID = nil
        currentSource = nil
        loadError = nil
        isLoading = false
        photosAuthNeeded = false
    }

    /// Put the grid into the "Photos Library selected but access not granted"
    /// state — no source, no assets, but `photosAuthNeeded` flips on so the
    /// empty state can surface a "Grant Access" CTA. Called by AppShell when
    /// the user clicks a Photos filter while PhotoKit is unauthorised.
    public func setPhotosAuthNeeded() {
        loadGeneration &+= 1
        assets = []
        selectedID = nil
        currentSource = nil
        loadError = nil
        isLoading = false
        photosAuthNeeded = true
    }

    /// Wipe the prior source's grid state and flip into the loading-spinner
    /// empty state ahead of an async PhotoKit fetch. Without this the user
    /// keeps seeing the previous folder's tiles for as long as the PhotoKit
    /// fetch + enumeration takes (seconds on large libraries) and assumes
    /// the click did nothing. Bumping `loadGeneration` here cancels any
    /// stale folder-load that's still resolving from a previous click.
    public func beginLoadingPhotosFilter() {
        loadGeneration &+= 1
        assets = []
        subfolders = []
        selectedID = nil
        currentSource = nil
        loadError = nil
        isLoading = true
        photosAuthNeeded = false
    }

    /// Seed the grid with a single filesystem asset and select it. Used by
    /// the UITest harness to bypass folder browsing entirely — the test
    /// driver passes a fixture path via `MAPLE_UITEST_FIXTURE` and the
    /// shell calls this so a single-asset library is ready before the
    /// harness flips into Full-image mode. The URL is treated as already
    /// scope-resolved (the running user's process can reach it without
    /// security-scope coordination); not appropriate for production
    /// flows. Tied to `#if DEBUG` at the call site in MapleApp.init.
    public func loadSingleAsset(url: URL) {
        loadGeneration &+= 1
        let ref = AssetRef(url: url, scopeParentURL: url.deletingLastPathComponent())
        assets = [ref]
        subfolders = []
        selectedID = ref.id
        currentSource = nil
        loadError = nil
        photosAuthNeeded = false
    }
}
