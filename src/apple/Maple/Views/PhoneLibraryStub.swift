// PhoneLibraryStub.swift — content for the Library tab of the iPhone
// tab-bar shell (responsive-program S1a, #597).
//
// Thin wrapper around the existing `AppShellIPhoneShell` (drawer-over-
// center-column). The drawer body continues to use the shared sidebar
// as a placeholder host so the Library tab is fully usable end-to-end
// while we stage the rest of the phone shell. S1b will replace the
// drawer with the spec'd 326pt Library-tab-scoped overlay; S2 will
// replace the center column with the real responsive library grid.
//
// We also demonstrate the **tab-bar hide on push** contract: any
// `NavigationLink(value: AssetRef)` resolves through the
// `.navigationDestination(for: AssetRef.self)` here and the pushed view
// calls `.toolbar(.hidden, for: .tabBar)`. S4 will replace the
// placeholder body with the real Loupe; the modifier pattern is the
// contract that all push destinations in the phone shell must follow.

#if os(iOS)

import SwiftUI
import MapleCore

struct PhoneLibraryStub<SidebarContent: View, ToolbarContentT: ToolbarContent>: View {
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
        // Tab-bar hide-on-push contract for the phone shell. S4 will
        // replace the destination body with the real Loupe.
        .navigationDestination(for: AssetRef.self) { _ in
            Text("Loupe — coming in S4")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .toolbar(.hidden, for: .tabBar)
        }
    }
}

#endif
