// AppShellIPhoneShell.swift — iPhone top-level shell, lifted out of
// AppShell.swift as part of the multi-PR split tracked in #123 (slice 6).
//
// What's in here:
//   • `AppShellIPhoneShell` — the iPhone `adaptiveShell` (drawer overlay
//     wrapping a NavigationStack-hosted center column) plus the Info
//     sheet that hangs off it. The drawer-stay-open + tap-outside-
//     dismiss behaviour lives inside `AppShellIPhoneDrawer`; this struct
//     just composes the drawer, the center column, the iPhone-specific
//     toolbar items, and the iPhone-specific Info sheet.
//
// Responsive-program S1a (#597): Settings used to be a modal sheet
// presented from this shell. Settings is now a top-level tab in
// `PhoneTabShell`, so the `showSettings` binding + `.sheet` wiring
// have been removed. This struct is also no longer mounted from
// `AppShell.body` directly — `PhoneLibraryStub` (the Library tab's
// content) wraps it. We keep the standalone struct so the drawer-+-
// center-column composition still has a single owner.
//
// State surface: the iPhone shell takes a pre-built `sharedSidebar`
// (`AppShellSidebar`) plus the same bindings + closures the Mac shell
// gets, and one iPhone-only flag (`iPhoneInfoSheet` for the Info
// detail sheet). Wiring the iPhone-only toolbar items (hamburger +
// Info) is delegated to `AppShellIPhoneToolbar`; the shared Browse/
// Full-image content is taken as a `toolbarContent` builder so the
// call site can hand in `browseToolbarContent` unchanged.

#if os(iOS)
import SwiftUI
import MapleCore

struct AppShellIPhoneShell<SidebarContent: View, ToolbarContentT: ToolbarContent>: View {
    /// Drawer-snapped state; the hamburger writes this with a spring
    /// animation, the drawer reads it to decide rest-state.
    @Binding var isDrawerOpen: Bool
    /// Browse vs. Full-image — read straight off AppShell, forwarded to
    /// the drawer (which gates edge-open on it) and used to drive the
    /// nav-bar title + iPhone-only toolbar item visibility.
    let mode: AppShell.Mode
    /// Active EditSession used by the Info sheet's DetailPanel and as the
    /// source of the Full-image title.
    let selectedSession: EditSession?
    /// Browse-mode title — shown in the navigation bar when not in Full-image.
    let libraryTitle: String

    // Info sheet — iPhone surfaces DetailPanel via a trailing-toolbar Info
    // button → modal sheet, since the iPhone shell can't accommodate a
    // right-hand inspector column.
    @Binding var iPhoneInfoSheet: Bool

    // Center-column state — forwarded straight to `AppShellCenterColumn`.
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

    /// Pre-built sidebar — the drawer renders this as its overlay content.
    let sidebar: () -> SidebarContent
    /// Pre-built shared toolbar content — composed alongside the iPhone-
    /// only hamburger + Info items inside the NavigationStack's `.toolbar`.
    let toolbarContent: () -> ToolbarContentT

    // Center-column callbacks — all forward into AppShell action methods.
    let onSelectCloudAsset: (SearchAsset, URL) -> Void
    /// Dismiss the cloud search UI.
    let onCloseSearch: () -> Void
    let onSelectLocalAsset: (ImageRef) -> Void
    let onGrantPhotosAccess: () -> Void
    let onNavigateFolder: (URL) -> Void
    let onOpenEditor: (AssetRef) -> Void
    let onPrimeSession: (AssetRef) -> Void
    let onFullImageFallback: () -> Void

    var body: some View {
        AppShellIPhoneDrawer(
            isDrawerOpen: $isDrawerOpen,
            mode: mode,
            // libraryTitle is the active source label (e.g. "All Photos" or a
            // folder name). The drawer's connection-identity row is a stub for
            // v0.1 — the Maple-instance switcher isn't built yet — so we feed
            // it the active source label as the closest available identity hint.
            // S1a / future work will surface the real `maple.lawrence.io` style
            // connection identity from the selected source.
            connectionIdentity: libraryTitle,
            tertiarySummary: "",
            // S1a (PR pending) wires this to flip the bottom-tab to "search".
            // Until then the existing iPhone shell has no Search tab to switch
            // to, so the callback is a no-op; the drawer still posts
            // .mapleFocusSearch for any future listener.
            onSearchPillTap: {},
            mainContent: {
                // Responsive-program S1a (#597): the surrounding
                // PhoneTabShell already provides a per-tab
                // NavigationStack, so this struct no longer wraps its
                // own. Toolbar items + nav-title attach directly to the
                // center column.
                iPhoneMain
            },
            sidebarContent: {
                // Drawer-stay-open by design: the user wants to drill down a
                // cloud folder tree and toggle expand/collapse without the
                // drawer collapsing on every selection. Selection still updates
                // the underlying browse grid; the user closes the drawer
                // manually via tap-on-dim or drag-back when ready to look at it.
                sidebar()
            }
        )
        .sheet(isPresented: $iPhoneInfoSheet) {
            NavigationStack {
                DetailPanel(session: selectedSession, isFullImage: mode == .fullImage)
                    .navigationTitle("Info")
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Done") { iPhoneInfoSheet = false }
                        }
                    }
            }
            .presentationDetents([.medium, .large])
        }
        // Settings sheet dropped in responsive-program S1a (#597) — Settings
        // is now a top-level tab in PhoneTabShell.
    }

    @ViewBuilder
    private var iPhoneMain: some View {
        AppShellCenterColumn(
            isFullImage: mode == .fullImage,
            selectedSession: selectedSession,
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
            onSelectCloudAsset: onSelectCloudAsset,
            onCloseSearch: onCloseSearch,
            onSelectLocalAsset: onSelectLocalAsset,
            onGrantPhotosAccess: onGrantPhotosAccess,
            onNavigateFolder: onNavigateFolder,
            onOpenEditor: onOpenEditor,
            onPrimeSession: onPrimeSession,
            onFullImageFallback: onFullImageFallback
        )
        .navigationTitle(mode == .fullImage
                         ? (selectedSession?.asset.displayName ?? "Image")
                         : libraryTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            AppShellIPhoneToolbar(
                isBrowse: mode == .browse,
                isFullImage: mode == .fullImage,
                isDrawerOpen: $isDrawerOpen,
                onInfo: { iPhoneInfoSheet = true }
            )
            toolbarContent()
        }
    }
}
#endif
