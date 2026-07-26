// PhoneTabShell.swift — top-level iPhone shell for the responsive
// program (S1a, #597). Hosts a `TabView` with three NavigationStack
// tabs (Library / Search / Settings) so each tab preserves its own
// push depth and the bottom tab bar stays put while drilling down.
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

    /// Live text for the Search tab's native `.searchable` field (the
    /// iOS 26 `Tab(role: .search)` search bar). Bound into `PhoneSearchTab`.
    @State private var searchQuery: String = ""

    @Binding var isDrawerOpen: Bool
    let mode: AppShell.Mode
    let selectedSession: EditSession?
    let libraryTitle: String

    let cloudTimelineVM: CloudTimelineViewModel?
    let cloudTimelineThumbClient: CloudThumbClient?
    let cloudTimelineThumbCache: CloudThumbCache?
    let allSourcesTimelineVM: AllSourcesTimelineViewModel?
    let allSourcesTimelineThumbCache: CloudThumbCache?
    let isSearchActive: Bool
    let searchVM: SearchViewModel?
    let searchThumbClient: CloudThumbClient?
    let searchThumbCache: CloudThumbCache?
    @Binding var browseDisplayMode: GridDisplayMode
    let browseVM: BrowseViewModel
    @Binding var sessions: [AssetRef.ID: EditSession]

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
                    clipboard: clipboard
                )
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
                    PhoneSettingsView()
                        .navigationTitle("Settings")
                        .navigationBarTitleDisplayMode(.inline)
                }
            }
        }
        // iOS 26 floating tab bar that minimizes on scroll — the collapse
        // behaviour the Search screen used to fake with a custom pill.
        .tabBarMinimizeBehavior(.onScrollDown)
        .tint(MapleTokens.primary)
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
}

#endif
