// PhoneTabShell.swift — top-level iPhone shell for the responsive
// program (S1a, #597). Hosts a `TabView` with NavigationStack tabs
// (Library / Map / Search / Settings) so each tab preserves its own
// push depth and the bottom tab bar stays put while drilling down.
//
// The Map tab (#2878) follows Search's shape, not Library's: it owns its
// own `mapPath` navigation stack rather than threading `mapVM` into the
// Library tab's `AppShellIPhoneShell` call site. `AppShell`'s `openMap()`
// (shared with the Mac/iPad sidebar's MAP row) still clears the shared
// `browseVM` and flips `librarySelection` globally, exactly as it does on
// Mac/iPad — an independent call site does NOT protect the Library tab's
// underlying content from that side effect (visiting Map still leaves the
// Library tab's grid empty until the user picks a new source from the
// drawer, same trade-off the pre-existing Timeline-via-drawer entry point
// already accepts). What the independent call site DOES avoid is a
// visual/render-priority problem: `AppShellCenterColumn`'s map branch
// takes precedence over the grid, so if `mapVM` were ALSO threaded into
// the Library tab's call site, that tab would keep showing the map (not
// its own grid) after every Map-tab visit, for as long as
// `librarySelection == .map` — i.e. the two tabs would visually collapse
// into one. Keeping the Map tab's `AppShellCenterColumn` call separate
// means only the Map tab ever renders `MapView`.
//
// AppShell.body dispatches between this shell and the Mac/iPad pane
// shell via `MapleShellKind.current == .phoneTab`. Persistence: the
// active tab survives a cold restart via `@AppStorage("cm.tab.shell")`.
// We deliberately introduce `cm.tab.shell` (not the original `cm.tab`)
// to keep the phone shell's tab key separate from any future Detail-
// panel tab key collision — see Risk §6.1 in the S1 spec. Today the
// codebase has zero `@AppStorage("cm.tab")` use, so this is forward-
// compatible only.
//
// S2 (#623) swaps the center column for the responsive `LibraryGrid`
// (chosen by AppShellCenterColumn based on the layout env), and the
// `PhoneLibraryStub` wrapper has been renamed `PhoneLibraryView` now
// that the stub text is gone. S7 fills PhoneSearchStub. S8 (#1903)
// replaces the embedded SettingsView with an iOS Settings-style List
// (`PhoneSettingsView`).

#if os(iOS)

import SwiftUI
import MapleCore
import UIKit

struct PhoneTabShell<SidebarContent: View, ToolbarContentT: ToolbarContent>: View {
    /// Cold-start tab restoration. Distinct from any Detail-panel tab
    /// key (see file header). Default `"library"` matches the spec.
    @AppStorage("cm.tab.shell") private var activeTab: String = "library"

    /// Library tab navigation stack. A Library cell tap appends
    /// `.preview(asset)` here, which the tab's `NavigationStack(path:)` pushes
    /// and `PhoneLibraryView`'s `.navigationDestination(for:
    /// LibraryDestination.self)` resolves — `.preview` → the fast Preview
    /// surface, `.edit` → `EditorDestination → EditorView` (Fast Preview §1;
    /// S5 #625/#791). Each destination's back button calls `dismiss()`, which
    /// pops this path. A typed `[LibraryDestination]` (Hashable) keeps push/pop
    /// trivial vs. a type-erased `NavigationPath`. Owned by `AppShell` (bound
    /// in) so the deep-link / document-open image-open paths can push onto the
    /// same stack a grid tap uses.
    @Binding var libraryPath: [LibraryDestination]

    /// `CloudSource` for the asset most recently pushed onto `libraryPath`.
    /// `PhoneLibraryView`'s Preview destination falls back to this when
    /// `browseVM.currentSource` is nil, which it is for a cloud Timeline tap —
    /// leaving Preview no way to reach `/api/fs/preview` (#2376).
    ///
    /// Every push sets it (see `pushPreview`), including to `nil` for local
    /// assets. It must not persist across pushes: `prepareLocalPhotoKitSession`
    /// never touches `browseVM`, so `currentSource` stays nil for a local-only
    /// PhotoKit push, and a leftover `CloudSource` here would be applied to it
    /// — sending `/api/fs/thumb` a PhotoKit local id and bypassing the
    /// PhotoKit fast path entirely.
    @State private var cloudPreviewSource: (any ImageSource)?

    /// Map tab's own navigation stack (#2878) — independent of `libraryPath`,
    /// same shape `PhoneSearchTab`'s own `path` uses: a pin/cluster tap opens
    /// the map's filtered search results, and tapping a result pushes
    /// `.preview` here rather than onto the Library tab's stack.
    @State private var mapPath: [LibraryDestination] = []
    /// `CloudSource` for the map-search result currently pushed on `mapPath`
    /// — same role as `cloudPreviewSource` for the Library tab's pushes.
    @State private var mapPreviewSource: (any ImageSource)?

    /// Live text for the Search tab's native `.searchable` field (the
    /// iOS 26 `Tab(role: .search)` search bar). Bound into `PhoneSearchTab`.
    @State private var searchQuery: String = ""

    /// The AppShell-root reveal action (loads the containing folder into
    /// browse). The iPhone shell wraps it to ALSO switch to the Library tab —
    /// AppShell can't do that itself because `activeTab` lives here (#2518).
    @Environment(\.revealFolderAction) private var rootRevealFolder

    @Binding var isDrawerOpen: Bool
    let mode: AppShell.Mode
    let selectedSession: EditSession?
    let libraryTitle: String

    let cloudTimelineVM: CloudTimelineViewModel?
    let cloudTimelineThumbClient: CloudThumbClient?
    let cloudTimelineThumbCache: CloudThumbCache?
    let allSourcesTimelineVM: AllSourcesTimelineViewModel?
    let allSourcesTimelineThumbCache: CloudThumbCache?
    /// Map tab state (#2878) — forwarded straight to the Map tab's own
    /// `AppShellCenterColumn` call site (`mapTabContent`). Populated by
    /// AppShell's `openMap()`, same three values `AppShellMacLayout` gets
    /// from the Mac/iPad sidebar's MAP row.
    let mapVM: MapViewModel?
    let mapThumbClient: CloudThumbClient?
    let mapThumbCache: CloudThumbCache?
    /// Why the Map tab has no `mapVM` yet (#2848) — forwarded to
    /// `mapTabContent`'s `AppShellCenterColumn` so it renders
    /// `MapEmptyState` (no cloud account / sign-in required / connecting)
    /// instead of falling through to the shared `browseVM`'s grid.
    let mapUnavailableReason: MapUnavailableReason?
    let isSearchActive: Bool
    let searchVM: SearchViewModel?
    let searchThumbClient: CloudThumbClient?
    let searchThumbCache: CloudThumbCache?
    @Binding var browseDisplayMode: GridDisplayMode
    let browseVM: BrowseViewModel
    @Binding var sessions: [AssetRef.ID: EditSession]

    /// Passed through to the Settings tab so ServerAdmin (#2766) resolves
    /// the app's shared per-server `AuthSession` rather than minting a new
    /// one. Defaults to the preview fallback, which is not cached.
    var sessionFor: @MainActor (URL) -> AuthSession = AppShell.defaultSessionResolver

    /// iPhone Search tab (S7): resolved-account key, session factory, and
    /// result-tap resolver. Distinct from the desktop overlay's `searchVM`.
    let phoneSearchServerKey: String?
    let makePhoneSearchSession: () async -> PhoneSearchSession?
    let resolveSearchAsset: (SearchAsset, URL) -> ResolvedCloudAsset

    let sidebar: () -> SidebarContent
    let toolbarContent: () -> ToolbarContentT

    // Cloud Timeline / Search (and merged-PhotoKit) taps. On iPhone these
    // build the asset's `EditSession` and RETURN its `AssetRef` (#809) so the
    // shell can push the S5 `EditorView` via this tab's `NavigationStack` —
    // exactly like a `LibraryGrid` cell tap — instead of AppShell flipping
    // `mode` the way the Mac/iPad pane shell does. A `nil` return means
    // resolution failed (e.g. PhotoKit unavailable) and nothing is pushed.
    // Mac / iPad keep the `mode`-flip handlers (they have no NavigationStack)
    // — that wiring is unchanged in `AppShell.macShell`.
    let onSelectCloudAsset: (SearchAsset, URL) -> ResolvedCloudAsset?
    /// Map pin/cluster tap (#2830) → AppShell activates search filtered by
    /// the resolved target (a place name, or the has-GPS scope fallback).
    /// Forwarded to the Map tab's `AppShellCenterColumn` call site (#2878) —
    /// mirrors `AppShellMacLayout`'s identically-named property.
    let onSelectMapPlace: (MapPlaceSearchTarget) -> Void
    /// MAP tab selection (#2878) — resolves the account-wide session and
    /// stands up `mapVM` / `mapThumbClient` / `mapThumbCache` on AppShell.
    /// Mirrors the Mac/iPad sidebar's MAP row (`AppShellSidebar.onSelectMap`)
    /// — the phone tab shell has no sidebar, so the Map tab itself is the
    /// entry point.
    let onSelectMap: () -> Void
    let onCloseSearch: () -> Void
    let onSelectLocalAsset: (ImageRef) -> AssetRef?
    let onGrantPhotosAccess: () -> Void
    let onNavigateFolder: (URL) -> Void
    let onOpenEditor: (AssetRef) -> Void
    let onPrimeSession: (AssetRef) -> Void
    let onFullImageFallback: () -> Void
    /// #2299: resolves the iPhone Preview sibling list for a Timeline-opened
    /// asset — forwarded straight through to `PhoneLibraryView`.
    let timelinePreviewSiblingAssets: (AssetRef) -> [AssetRef]
    /// M2: triggers panorama merge view when the user taps "Merge to Panorama…".
    var onMergePanorama: (() -> Void)? = nil
    /// M4: triggers batch metadata editor when the user taps "Edit Metadata…".
    var onEditMetadata: (() -> Void)? = nil
    /// #2641: triggers the batch rename sheet when the user taps "Batch Rename…".
    var onBatchRename: (() -> Void)? = nil
    /// #2653: Delete key / "Move to Trash" context-menu item, forwarded
    /// through to BrowseGrid via PhoneLibraryView / AppShellIPhoneShell.
    var onTrashAssets: (([AssetRef.ID]) -> Void)? = nil
    /// #944: app-level copy/paste/sync-adjustments clipboard, forwarded
    /// through to BrowseGrid via PhoneLibraryView / AppShellIPhoneShell.
    var clipboard: AdjustmentClipboard? = nil

    var body: some View {
        // The LIBRARY drawer wraps the whole tab view so it overlays the
        // footer tab bar AND the per-tab top bars at full device height
        // (#692). The Library tab's hamburger writes `isDrawerOpen`; the
        // drawer reads it, slides over everything, and dims the tab view.
        AppShellIPhoneDrawer(
            isDrawerOpen: $isDrawerOpen,
            // The drawer owns the edge swipe only at the root. Deeper screens
            // leave it to NavigationStack, producing Edit → Preview → Browse.
            mode: activeTab == "library" && libraryPath.isEmpty ? .browse : .preview,
            mainContent: { tabView },
            sidebarContent: sidebar
        )
    }

    private var tabView: some View {
        TabView(selection: $activeTab) {
            Tab("Library", systemImage: "photo.on.rectangle.angled", value: "library") {
              NavigationStack(path: $libraryPath) {
                PhoneLibraryView(
                    isDrawerOpen: $isDrawerOpen,
                    mode: mode,
                    selectedSession: selectedSession,
                    libraryTitle: libraryTitle,
                    cloudTimelineVM: cloudTimelineVM,
                    cloudTimelineThumbClient: cloudTimelineThumbClient,
                    cloudTimelineThumbCache: cloudTimelineThumbCache,
                    allSourcesTimelineVM: allSourcesTimelineVM,
                    allSourcesTimelineThumbCache: allSourcesTimelineThumbCache,
                    isSearchActive: isSearchActive,
                    searchVM: searchVM,
                    searchThumbClient: searchThumbClient,
                    searchThumbCache: searchThumbCache,
                    browseDisplayMode: $browseDisplayMode,
                    browseVM: browseVM,
                    sessions: $sessions,
                    libraryPath: $libraryPath,
                    toolbarContent: toolbarContent,
                    // Cloud Timeline / Search taps: resolve the asset's session
                    // (returns its AssetRef) and push the S5 Editor onto THIS
                    // tab's NavigationStack — same target as a LibraryGrid cell
                    // tap (`onOpenEditor` below), not the legacy fullImage mode
                    // flip (#809). `PhoneLibraryView`'s
                    // `.navigationDestination(for: LibraryDestination)` resolves
                    // the pushed `.preview` to PreviewDestination, reusing the
                    // session (incl. its CloudSidecarStore) created during
                    // resolution.
                    //
                    // The resolved `CloudSource` is stashed alongside the push:
                    // the browse VM holds no source for a Timeline tap, and
                    // without one Preview downloads the whole RAW (#2376).
                    onSelectCloudAsset: { asset, server in
                        if let resolved = onSelectCloudAsset(asset, server) {
                            pushPreview(resolved.ref, cloudSource: resolved.source)
                        }
                    },
                    cloudPreviewSource: cloudPreviewSource,
                    onCloseSearch: onCloseSearch,
                    // Merged-PhotoKit (local-only) timeline cells: same S5
                    // push as cloud assets (#809).
                    onSelectLocalAsset: { ref in
                        if let assetRef = onSelectLocalAsset(ref) {
                            pushPreview(assetRef)
                        }
                    },
                    onGrantPhotosAccess: onGrantPhotosAccess,
                    onNavigateFolder: onNavigateFolder,
                    // Phone Library tap pushes the fast Preview surface onto
                    // THIS tab's NavigationStack (Fast Preview §1) — NOT the
                    // editor directly. Preview's Edit button pushes `.edit`
                    // from inside PhoneLibraryView's resolved destination. The
                    // tab bar is hidden on push (#791). The AppShell-provided
                    // `onOpenEditor` (mode flip) stays in use by the
                    // tablet/desktop pane shell, which has no NavigationStack.
                    // Explicit closure, not a bare `pushPreview` reference:
                    // Swift can't apply the defaulted `cloudSource:` when a
                    // function is used as a value. A local library cell is
                    // never a cloud asset, so nil is right — and it clears any
                    // source from a previous push.
                    onOpenEditor: { pushPreview($0) },
                    onPrimeSession: onPrimeSession,
                    onFullImageFallback: onFullImageFallback,
                    timelinePreviewSiblingAssets: timelinePreviewSiblingAssets,
                    onMergePanorama: onMergePanorama,
                    onEditMetadata: onEditMetadata,
                    onBatchRename: onBatchRename,
                    onTrashAssets: onTrashAssets,
                    clipboard: clipboard
                )
              }
            }

            Tab("Map", systemImage: "map", value: "map") {
                NavigationStack(path: $mapPath) {
                    mapTabContent
                        .navigationTitle("Map")
                        .navigationBarTitleDisplayMode(.inline)
                        // Mirrors PhoneLibraryView / PhoneSearchTab's resolution
                        // (Fast Preview §1): `.preview` → the fast static
                        // surface, `.edit` → the editor. Both hide the tab bar +
                        // system nav bar; each ships its own 44pt header with a
                        // back button.
                        .navigationDestination(for: LibraryDestination.self) { destination in
                            Group {
                                switch destination {
                                case .preview(let ref):
                                    PreviewDestination(
                                        asset: ref,
                                        // A map search result is a single-asset
                                        // preview, same shape PhoneSearchTab uses
                                        // for its own results — there's no
                                        // sibling list to hand the filmstrip.
                                        assets: [ref],
                                        source: mapPreviewSource,
                                        sessions: $sessions,
                                        onClose: popMapPreviewWithoutAnimation,
                                        onEdit: { mapPath.append(.edit($0)) },
                                        onSelectionChanged: { _ in }
                                    )
                                case .edit(let ref):
                                    EditorDestination(asset: ref, sessions: $sessions)
                                }
                            }
                            .toolbar(.hidden, for: .tabBar)
                            .toolbar(.hidden, for: .navigationBar)
                        }
                }
            }

            Tab("Search", systemImage: "magnifyingglass", value: "search", role: .search) {
                PhoneSearchTab(
                    sessions: $sessions,
                    query: $searchQuery,
                    serverKey: phoneSearchServerKey,
                    makeSession: makePhoneSearchSession,
                    resolveAsset: resolveSearchAsset
                )
            }

            Tab("Settings", systemImage: "gearshape", value: "settings") {
                NavigationStack {
                    // S8 (#1903): grouped List + push, replacing the S1a
                    // placeholder that embedded SettingsView (itself a
                    // TabView) and produced a nested footer tab bar.
                    PhoneSettingsView(sessionFor: sessionFor)
                        .navigationTitle("Settings")
                        .navigationBarTitleDisplayMode(.inline)
                }
            }
        }
        // iOS 26 floating tab bar that minimizes on scroll — the collapse
        // behaviour the Search screen used to fake with a custom pill.
        .tabBarMinimizeBehavior(.onScrollDown)
        .tint(MapleTokens.primary)
        // Face chips in the info pane → prefill the Search tab and run it
        // (#2518). Overrides the AppShell-root (mac/iPad) `searchForText` for
        // the iPhone global Search tab. Re-injected across the info sheet by
        // `PreviewView` / `EditorDestination`.
        .environment(\.searchForText, SearchTextAction { text in searchFor(text) })
        // Folder row → reveal the containing folder. Wrap the root action so
        // it ALSO switches to the Library tab, where the folder was loaded —
        // otherwise the user stays on the Search tab (#2518).
        .environment(\.revealFolderAction, RevealFolderAction { asset in
            rootRevealFolder?(asset)
            activeTab = "library"
        })
        // #2878: stand up the map session whenever the Map tab becomes
        // active — including on a cold launch that restores straight onto
        // it (`initial: true`), matching the Mac/iPad sidebar's MAP row,
        // which fires `openMap()` on every tap of that row.
        .onChange(of: activeTab, initial: true) { _, newValue in
            if newValue == "map" { onSelectMap() }
        }
    }

    /// Map tab content (#2878) — its own `AppShellCenterColumn` call site,
    /// independent of the Library tab's (`PhoneLibraryView` →
    /// `AppShellIPhoneShell`; see this file's header for why). Reuses the
    /// exact same closures the Library tab wires below (`onSelectCloudAsset`,
    /// `onSelectLocalAsset`, `onGrantPhotosAccess`, `onNavigateFolder`,
    /// `onPrimeSession`, `onFullImageFallback`) — only the push target
    /// (`mapPath` vs. `libraryPath`) differs.
    @ViewBuilder
    private var mapTabContent: some View {
        AppShellCenterColumn(
            isFullImage: false,
            selectedSession: nil,
            cloudTimelineVM: nil,
            cloudTimelineThumbClient: nil,
            cloudTimelineThumbCache: nil,
            allSourcesTimelineVM: nil,
            allSourcesTimelineThumbCache: nil,
            mapVM: mapVM,
            mapThumbClient: mapThumbClient,
            mapThumbCache: mapThumbCache,
            mapUnavailableReason: mapUnavailableReason,
            isSearchActive: isSearchActive,
            searchVM: searchVM,
            searchThumbClient: searchThumbClient,
            searchThumbCache: searchThumbCache,
            browseDisplayMode: $browseDisplayMode,
            browseVM: browseVM,
            sessions: $sessions,
            // Pin/cluster tap → CloudSearchView; tapping a result resolves
            // its session and pushes Preview onto THIS tab's stack — same
            // shape as the Library tab's `onSelectCloudAsset` wrapper below.
            onSelectCloudAsset: { asset, server in
                if let resolved = onSelectCloudAsset(asset, server) {
                    pushMapPreview(resolved.ref, cloudSource: resolved.source)
                }
            },
            onSelectMapPlace: onSelectMapPlace,
            onCloseSearch: onCloseSearch,
            // No `cloudSource` argument — if the map can't stand up (e.g. no
            // signed-in cloud account) and this tab falls back to rendering
            // the grid off the shared `browseVM`, a local asset tap here must
            // NOT inherit `mapPreviewSource` left over from an earlier
            // cloud-search-result push on this same tab (#2878 review).
            onSelectLocalAsset: { ref in
                if let assetRef = onSelectLocalAsset(ref) {
                    pushMapPreview(assetRef)
                }
            },
            onGrantPhotosAccess: onGrantPhotosAccess,
            onNavigateFolder: onNavigateFolder,
            onOpenEditor: { pushMapPreview($0) },
            onPrimeSession: onPrimeSession,
            onFullImageFallback: onFullImageFallback
        )
    }

    /// Prefill the Search tab with `text` and switch to it. `SearchView`'s
    /// `.onAppear` re-issues a non-empty query, so the search runs on arrival.
    /// Clearing `libraryPath` pops any open editor/preview (and its info
    /// sheet) so the user lands cleanly on the results.
    private func searchFor(_ text: String) {
        searchQuery = text
        libraryPath = []
        activeTab = "search"
    }

    /// Preview supplies its own non-interactive scale/fade presentation. Turn
    /// off NavigationStack's horizontal push so the two animations never mix.
    /// `cloudSource` is assigned unconditionally — passing nothing CLEARS any
    /// source left over from a previous push. Making it a parameter rather
    /// than a separate assignment at one call site means a new push site
    /// cannot silently inherit the last asset's source.
    private func pushPreview(_ asset: AssetRef, cloudSource: (any ImageSource)? = nil) {
        cloudPreviewSource = cloudSource
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            libraryPath.append(.preview(asset))
        }
    }

    /// `pushPreview`'s Map-tab counterpart, targeting `mapPath` /
    /// `mapPreviewSource` instead of `libraryPath` / `cloudPreviewSource`.
    /// Same unconditional-assignment discipline: a local/grid-fallback push
    /// (no `cloudSource` argument) must CLEAR any source left over from an
    /// earlier cloud-search-result push on this tab, or a later local asset
    /// would inherit a stale cloud `ImageSource` and mis-resolve its Preview
    /// image tiers.
    private func pushMapPreview(_ asset: AssetRef, cloudSource: (any ImageSource)? = nil) {
        mapPreviewSource = cloudSource
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            mapPath.append(.preview(asset))
        }
    }

    /// Pop the Map tab's top destination without the stack's own slide.
    /// `PreviewDestination` runs its own scale/fade close, so a second
    /// animation here would play on top of one that has already ended. Same
    /// helper as `PhoneLibraryView.popPreviewWithoutAnimation` / the Search
    /// tab's `PhoneSearchTab.popWithoutAnimation`, targeting `mapPath`.
    private func popMapPreviewWithoutAnimation() {
        guard !mapPath.isEmpty else { return }
        var transaction = Transaction()
        transaction.disablesAnimations = true
        UIView.performWithoutAnimation {
            withTransaction(transaction) {
                _ = mapPath.removeLast()
            }
        }
    }
}

#endif
