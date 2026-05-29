// PhoneLibraryView.swift — content for the Library tab of the iPhone
// tab-bar shell (responsive-program S1a, #597; S2, #623).
//
// Thin wrapper around the existing `AppShellIPhoneShell` (drawer-over-
// center-column). The center column renders the S2 `LibraryGrid`
// (responsive 3-col edge-bleed on phone) via `AppShellCenterColumn`'s
// layout-aware switch — the original "stub" placeholder text has been
// retired.
//
// We also demonstrate the **tab-bar hide on push** contract: any
// `NavigationLink(value: AssetRef)` resolves through the
// `.navigationDestination(for: AssetRef.self)` here and the pushed view
// calls `.toolbar(.hidden, for: .tabBar)`. Until S5 lands the
// destination is a placeholder Text; S5 will replace it with the
// Editor view. The modifier pattern is the contract that all push
// destinations in the phone shell must follow.

#if os(iOS)

import SwiftUI
import MapleCore

struct PhoneLibraryView<SidebarContent: View, ToolbarContentT: ToolbarContent>: View {
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
    let browseVM: BrowseViewModel
    @Binding var sessions: [AssetRef.ID: EditSession]

    let sidebar: () -> SidebarContent
    let toolbarContent: () -> ToolbarContentT

    let onSelectCloudAsset: (SearchAsset, URL) -> Void
    let onCloseSearch: () -> Void
    let onSelectLocalAsset: (ImageRef) -> Void
    let onGrantPhotosAccess: () -> Void
    let onNavigateFolder: (URL) -> Void
    let onOpenEditor: (AssetRef) -> Void
    let onPrimeSession: (AssetRef) -> Void
    let onFullImageFallback: () -> Void

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
            browseVM: browseVM,
            sessions: $sessions,
            sidebar: sidebar,
            toolbarContent: toolbarContent,
            onSelectCloudAsset: onSelectCloudAsset,
            onCloseSearch: onCloseSearch,
            onSelectLocalAsset: onSelectLocalAsset,
            onGrantPhotosAccess: onGrantPhotosAccess,
            onNavigateFolder: onNavigateFolder,
            onOpenEditor: onOpenEditor,
            onPrimeSession: onPrimeSession,
            onFullImageFallback: onFullImageFallback
        )
        // Tab-bar hide-on-push contract for the phone shell. S4 was
        // dropped (#619); cell tap pushes straight into the S5 Editor
        // (#625) — the Editor canvas IS the full-image view (no
        // separate Loupe).
        .navigationDestination(for: AssetRef.self) { ref in
            EditorDestination(asset: ref, sessions: $sessions)
                .toolbar(.hidden, for: .tabBar)
        }
    }
}

#endif
