// PhoneLibraryView.swift — content for the Library tab of the iPhone
// tab-bar shell (responsive-program S1a, #597; S2, #623).
//
// Thin wrapper around the existing `AppShellIPhoneShell` (drawer-over-
// center-column). The center column renders the S2 `LibraryGrid`
// (responsive 3-col edge-bleed on phone) via `AppShellCenterColumn`'s
// layout-aware switch — the original "stub" placeholder text has been
// retired.
//
// We also implement the **tab-bar hide on push** contract: a Library
// cell tap appends the tapped `AssetRef` to `PhoneTabShell`'s
// `libraryPath`, which the tab's `NavigationStack(path:)` pushes and the
// `.navigationDestination(for: AssetRef.self)` here resolves into
// `EditorDestination → EditorView`, calling `.toolbar(.hidden, for:
// .tabBar)` so the bottom tab bar disappears for the duration (#625,
// #791). The modifier pattern is the contract that all push destinations
// in the phone shell must follow.

#if os(iOS)

import SwiftUI
import MapleCore

struct PhoneLibraryView<ToolbarContentT: ToolbarContent>: View {
    @Binding var isDrawerOpen: Bool
    let mode: AppShell.Mode
    let selectedSession: EditSession?
    let libraryTitle: String
    @Binding var iPhoneInfoSheet: Bool

    let cloudTimelineVM: CloudTimelineViewModel?
    let cloudTimelineThumbClient: CloudThumbClient?
    let cloudTimelineThumbCache: CloudThumbCache?
    let isSearchActive: Bool
    let searchVM: SearchViewModel?
    let searchThumbClient: CloudThumbClient?
    let searchThumbCache: CloudThumbCache?
    @Binding var browseDisplayMode: GridDisplayMode
    /// Grid zoom level threaded from AppShell (#1550).
    @Binding var browseZoomLevel: GridZoomLevel
    let browseVM: BrowseViewModel
    @Binding var sessions: [AssetRef.ID: EditSession]

    let toolbarContent: () -> ToolbarContentT

    let onSelectCloudAsset: (SearchAsset, URL) -> Void
    let onCloseSearch: () -> Void
    let onSelectLocalAsset: (ImageRef) -> Void
    let onGrantPhotosAccess: () -> Void
    let onNavigateFolder: (URL) -> Void
    let onOpenEditor: (AssetRef) -> Void
    let onPrimeSession: (AssetRef) -> Void
    let onFullImageFallback: () -> Void
    /// M2: opens the panorama merge view when the user taps "Merge to Panorama…".
    var onMergePanorama: (() -> Void)? = nil

    var body: some View {
        AppShellIPhoneShell(
            isDrawerOpen: $isDrawerOpen,
            mode: mode,
            selectedSession: selectedSession,
            libraryTitle: libraryTitle,
            iPhoneInfoSheet: $iPhoneInfoSheet,
            cloudTimelineVM: cloudTimelineVM,
            cloudTimelineThumbClient: cloudTimelineThumbClient,
            cloudTimelineThumbCache: cloudTimelineThumbCache,
            isSearchActive: isSearchActive,
            searchVM: searchVM,
            searchThumbClient: searchThumbClient,
            searchThumbCache: searchThumbCache,
            browseDisplayMode: $browseDisplayMode,
            browseZoomLevel: $browseZoomLevel,
            browseVM: browseVM,
            sessions: $sessions,
            toolbarContent: toolbarContent,
            onSelectCloudAsset: onSelectCloudAsset,
            onCloseSearch: onCloseSearch,
            onSelectLocalAsset: onSelectLocalAsset,
            onGrantPhotosAccess: onGrantPhotosAccess,
            onNavigateFolder: onNavigateFolder,
            onOpenEditor: onOpenEditor,
            onPrimeSession: onPrimeSession,
            onFullImageFallback: onFullImageFallback,
            onMergePanorama: onMergePanorama
        )
        // Tab-bar hide-on-push contract for the phone shell. S4 was
        // dropped (#619); cell tap pushes straight into the S5 Editor
        // (#625) — the Editor canvas IS the full-image view (no
        // separate Loupe).
        .navigationDestination(for: AssetRef.self) { ref in
            EditorDestination(asset: ref, sessions: $sessions)
                // Hide both bars for the editor push (#791): the tab bar
                // (spec §2 "tab-bar hide on push"), and the system
                // navigation bar — `EditorView` ships its own 44pt
                // `EditorHeader` with a back button (→ `dismiss()`), so the
                // stack's nav bar would otherwise stack a second header +
                // redundant back chevron on top of it. Applied here at the
                // push site, not inside the shared `EditorView`.
                .toolbar(.hidden, for: .tabBar)
                .toolbar(.hidden, for: .navigationBar)
        }
    }
}

#endif
