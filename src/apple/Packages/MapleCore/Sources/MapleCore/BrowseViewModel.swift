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

    // MARK: - Multi-select (M1 — #1236 / #1234)

    /// True when the grid is in multi-select mode. Entering this mode keeps
    /// the existing single `selectedID` intact so switching back to normal
    /// browse restores the prior highlight without any extra bookkeeping.
    public var isSelecting: Bool = false

    /// IDs of all assets currently checked in multi-select mode. Only
    /// meaningful while `isSelecting == true`; always cleared when leaving
    /// select mode.
    public var selectedIDs: Set<AssetRef.ID> = []

    /// Non-nil while an async `loadFolder` is in flight.
    public var isLoading: Bool = false
    /// Last load error; views can surface a banner when non-nil.
    public var loadError: Error?
    /// When non-nil the user selected a Photos-library filter but the app
    /// doesn't yet have PhotoKit permission. Views should surface the
    /// permission panel rather than silently loading zero assets.
    public var photosAuthNeeded: Bool = false
    /// True while PhotoKit authorization is `.notDetermined` — the only state
    /// in which the system prompt can still be raised. Once the user declines,
    /// iOS never shows it again, so the panel must offer Settings rather than
    /// a Connect button that would silently do nothing (#2454). Only
    /// meaningful while `photosAuthNeeded` is true.
    public var photosAuthCanRequest: Bool = true
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
    @ObservationIgnored private var pagedPhotoKitSource: PhotoKitSource?
    @ObservationIgnored private var photoKitNextOffset = 0
    @ObservationIgnored private var photoKitTotalCount = 0
    @ObservationIgnored private var isLoadingPhotoKitPage = false
    private static let photoKitPageSize = 42
    private static let photoKitPrefetchDistance = 15

    public var selectedAsset: AssetRef? {
        assets.first { $0.id == selectedID }
    }

    public init() {}

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

    /// Publish two phone screens immediately, then retain PhotoKit's lazy
    /// fetch result as the backing store for scroll-driven paging.
    public func loadPhotoKitSource(_ source: PhotoKitSource) async {
        loadGeneration &+= 1
        let gen = loadGeneration
        isLoading = true
        pagedPhotoKitSource = source
        photoKitNextOffset = 0
        photoKitTotalCount = 0
        isLoadingPhotoKitPage = false
        defer { if gen == loadGeneration { isLoading = false } }

        do {
            async let total = source.imageCount()
            async let firstPage = source.images(offset: 0, limit: Self.photoKitPageSize)
            let (count, refs) = try await (total, firstPage)
            guard gen == loadGeneration else { return }
            assets = refs.map { makeAssetRef($0, source: source) }
            photoKitNextOffset = refs.count
            photoKitTotalCount = count
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

    public func loadMorePhotoKitIfNeeded(appearing id: AssetRef.ID) async {
        guard currentSource is PhotoKitSource,
              let source = pagedPhotoKitSource,
              !isLoadingPhotoKitPage,
              photoKitNextOffset < photoKitTotalCount,
              let index = assets.firstIndex(where: { $0.id == id }),
              index >= max(0, assets.count - Self.photoKitPrefetchDistance) else { return }

        isLoadingPhotoKitPage = true
        let gen = loadGeneration
        let offset = photoKitNextOffset
        defer { if gen == loadGeneration { isLoadingPhotoKitPage = false } }
        do {
            let refs = try await source.images(offset: offset, limit: Self.photoKitPageSize)
            guard gen == loadGeneration else { return }
            assets.append(contentsOf: refs.map { makeAssetRef($0, source: source) })
            photoKitNextOffset += refs.count
        } catch {
            guard gen == loadGeneration else { return }
            loadError = error
        }
    }

    /// Only called from the PhotoKit paging loaders (`loadPhotoKitSource`,
    /// `loadMorePhotoKitIfNeeded`) — every ref built here IS PhotoKit-backed,
    /// so `thumbnailProvenance` is tagged unconditionally (#2299).
    private func makeAssetRef(_ ref: ImageRef, source: any ImageSource) -> AssetRef {
        if let url = ref.url {
            return AssetRef(url: url, scopeParentURL: ref.scopeParentURL)
        }
        let ext = (ref.displayName as NSString).pathExtension.lowercased()
        return AssetRef(
            displayName: ref.displayName,
            hintExtension: ext.isEmpty ? nil : ext,
            stableID: ref.id,
            thumbnailProvenance: .photoKit,
            bytesProvider: { [source, ref] in try await source.rawBytes(for: ref) }
        )
    }

    // MARK: - Merged PhotoKit + Cloud timeline

    /// When set, BrowseGrid renders MergedCellView tiles instead of plain
    /// AssetRefs. Populated by `reloadMerged(photoKit:cloud:)`.
    public private(set) var mergedCells: [MergedTimelineCell] = []
    public private(set) var isMerged: Bool = false

    /// Load both sources, run the merge, and publish the result. Must be
    /// called from a context that can await; BrowseGrid's `.task` or
    /// AppShell's `.onChange` are both fine.
    public func reloadMerged(photoKit: PhotoKitSource, cloud: any ImageSource) async {
        loadGeneration &+= 1
        let gen = loadGeneration
        isLoading = true
        defer { if gen == loadGeneration { isLoading = false } }

        let l: [ImageRef]
        do { l = try await photoKit.images() } catch { l = [] }
        let c: [ImageRef]
        do { c = try await cloud.images() } catch { c = [] }

        guard gen == loadGeneration else { return }
        let merged = MergedTimelineSource.merge(local: l, cloud: c)
        guard gen == loadGeneration else { return }

        mergedCells = merged
        isMerged = true
        assets = []
        subfolders = []
        loadError = nil
        photosAuthNeeded = false
    }

    /// Drop merged state and return to plain-source mode.
    public func clearMerged() {
        mergedCells = []
        isMerged = false
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
        mergedCells = []
        isMerged = false
        isSelecting = false
        selectedIDs = []
    }

    /// Put the grid into the "Photos Library selected but access not granted"
    /// state — no source, no assets, but `photosAuthNeeded` flips on so the
    /// permission panel takes over. Called by AppShell when the user clicks a
    /// Photos filter while PhotoKit is unauthorised.
    ///
    /// `canRequest` is true only while authorization is `.notDetermined`; it
    /// decides whether the panel offers Connect or sends the user to Settings
    /// (#2454).
    public func setPhotosAuthNeeded(canRequest: Bool) {
        loadGeneration &+= 1
        assets = []
        selectedID = nil
        currentSource = nil
        loadError = nil
        isLoading = false
        photosAuthNeeded = true
        photosAuthCanRequest = canRequest
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

    /// Seed the grid with a single filesystem asset and select it. Two
    /// callers: the UITest harness (env-var fixture, bypassing folder
    /// browsing) and the document-open path ("Open With Maple" / `open -a`).
    ///
    /// `scopeParentURL` is the URL the sandboxed FFI read claims security
    /// scope on. A LaunchServices-opened document carries a security-scoped
    /// grant on the FILE itself, so that caller passes the file URL; pass it
    /// explicitly there. It defaults to the parent directory for callers whose
    /// scope sits on a bookmarked ancestor (folder walks) or who run
    /// unsandboxed. Without a valid scoped URL the sandbox denies the read and
    /// the canvas can't decode (#1589).
    public func loadSingleAsset(url: URL, scopeParentURL: URL? = nil) {
        loadGeneration &+= 1
        let ref = AssetRef(url: url, scopeParentURL: scopeParentURL ?? url.deletingLastPathComponent())
        assets = [ref]
        subfolders = []
        selectedID = ref.id
        currentSource = nil
        loadError = nil
        photosAuthNeeded = false
    }

    /// Cloud analog of `loadSingleAsset(url:)`. Used when the timeline
    /// hands AppShell a single SearchAsset to open in the editor — the
    /// AssetRef has already been built with a remote bytes-provider, no
    /// local URL. Mirrors the same invariants (one-cell list, no
    /// subfolders, generation-bumped) so a back-to-Browse flip doesn't
    /// ghost-render the prior selection.
    ///
    /// `source` is the asset's `CloudSource` and is load-bearing for Preview
    /// (#2376): a cloud `AssetRef` has no `primaryURL`, so both of Preview's
    /// image tiers dispatch on this source. Without it `ThumbnailProvider`
    /// has no display tier at all and `ThumbnailLoader` falls through to
    /// pulling the whole RAW through `bytesProvider` — the exact cost Preview
    /// exists to avoid. Kept optional so non-cloud callers are unaffected.
    public func loadSingleCloudAsset(_ ref: AssetRef, source: (any ImageSource)? = nil) {
        loadGeneration &+= 1
        assets = [ref]
        subfolders = []
        selectedID = ref.id
        currentSource = source
        loadError = nil
        photosAuthNeeded = false
    }

    /// Inject a completed panorama result into the library and select it.
    ///
    /// Called by the pano merge view (M5 of #1234) after a successful
    /// `RustPanoStitcher` run writes the PNG to `url`. Appends the new
    /// asset to the current `assets` list and sets it as the selected item
    /// so it appears highlighted in Browse. Does NOT reload the containing
    /// folder — the panorama output is treated as a first-class asset in the
    /// current library context without disrupting the user's scroll position.
    ///
    /// The `scopeParentURL` is set to the output file's parent directory so
    /// downstream FFI reads can re-claim the security scope on the right URL.
    /// NEVER modifies or touches the source RAWs — this method only registers
    /// the output.
    public func injectPanoResult(url: URL) {
        let ref = AssetRef(url: url, scopeParentURL: url.deletingLastPathComponent())
        assets.append(ref)
        selectedID = ref.id
    }

    /// Cloud equivalent of `loadFolder(url:)` — calls `CloudSource.listDir`
    /// for one directory level on the server and populates BOTH `assets`
    /// (image children) and `subfolders` (synthetic file URLs whose
    /// `.path` is the absolute server path). The grid renders folders
    /// first, then images, just like the local Filesystem flow.
    public func loadCloudDir(_ source: CloudSource, absPath: String) async {
        loadGeneration &+= 1
        let gen = loadGeneration
        isLoading = true
        defer { if gen == loadGeneration { isLoading = false } }

        do {
            await source.navigate(to: absPath)
            let listing = try await source.listDir(absPath: absPath)
            guard gen == loadGeneration else { return }

            let dirURLs = listing.dirs.map { URL(fileURLWithPath: $0.path) }
            let imageRefs = listing.images.map { img -> AssetRef in
                let id = "fs:\(img.path)"
                let displayName = img.name
                let ext = (img.name as NSString).pathExtension.lowercased()
                let capturedSource = source
                let capturedRef = ImageRef(id: id, displayName: displayName, url: nil)
                return AssetRef(
                    displayName: displayName,
                    hintExtension: ext.isEmpty ? nil : ext,
                    stableID: id,
                    bytesProvider: { [capturedSource, capturedRef] in
                        try await capturedSource.rawBytes(for: capturedRef)
                    }
                )
            }
            guard gen == loadGeneration else { return }

            assets = imageRefs
            subfolders = dirURLs
            selectedID = nil
            currentSource = source
            loadError = nil
            photosAuthNeeded = false
        } catch {
            guard gen == loadGeneration else { return }
            loadError = error
        }
    }

    // MARK: - Preview

    /// Sample `BrowseViewModel` for SwiftUI `#Preview` blocks. Skips the
    /// async loader plumbing entirely — assets are inserted directly so the
    /// grid can render its populated layout without touching any source
    /// actor. Issue #139.
    public enum PreviewState: Sendable {
        case empty
        case loaded(count: Int)
        case loading
        case error
        case photosAuthNeeded
    }

    public static func preview(_ state: PreviewState = .loaded(count: 12)) -> BrowseViewModel {
        let vm = BrowseViewModel()
        switch state {
        case .empty:
            break
        case .loaded(let count):
            vm.assets = (0..<count).map { i in
                AssetRef.preview(displayName: String(format: "IMG_%04d.dng", i + 1))
            }
            vm.selectedID = vm.assets.first?.id
        case .loading:
            vm.isLoading = true
        case .error:
            vm.loadError = NSError(
                domain: "MapleCore.BrowseViewModel.preview",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Couldn't load this folder."]
            )
        case .photosAuthNeeded:
            vm.photosAuthNeeded = true
        }
        return vm
    }
}
