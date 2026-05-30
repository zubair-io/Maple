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
// that the stub text is gone. S7 fills PhoneSearchStub. S8 will
// replace the embedded SettingsView with an iOS Settings-style List.

#if os(iOS)

import SwiftUI
import MapleCore

struct PhoneTabShell<SidebarContent: View, ToolbarContentT: ToolbarContent>: View {
    /// Cold-start tab restoration. Distinct from any Detail-panel tab
    /// key (see file header). Default `"library"` matches the spec.
    @AppStorage("cm.tab.shell") private var activeTab: String = "library"

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
        // The LIBRARY drawer wraps the whole tab view so it overlays the
        // footer tab bar AND the per-tab top bars at full device height
        // (#692). The Library tab's hamburger writes `isDrawerOpen`; the
        // drawer reads it, slides over everything, and dims the tab view.
        AppShellIPhoneDrawer(
            isDrawerOpen: $isDrawerOpen,
            mode: mode,
            mainContent: { tabView },
            sidebarContent: sidebar
        )
    }

    private var tabView: some View {
        TabView(selection: $activeTab) {
            NavigationStack {
                PhoneLibraryView(
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
            }
            .tabItem { Label("Library", systemImage: "photo.on.rectangle.angled") }
            .tag("library")

            NavigationStack {
                PhoneSearchStub()
            }
            .tabItem { Label("Search", systemImage: "magnifyingglass") }
            .tag("search")

            NavigationStack {
                // SettingsView is itself a TabView (General/Backup/Self
                // Hosted/Files) — embedding it inside the Settings tab's
                // NavigationStack yields nested tabs for S1a. S8 will
                // replace this with an iOS Settings-style List.
                SettingsView()
                    .navigationTitle("Settings")
                    .navigationBarTitleDisplayMode(.inline)
            }
            .tabItem { Label("Settings", systemImage: "gearshape") }
            .tag("settings")
        }
        .accentColor(MapleTokens.primary)
    }
}

#endif
