// AppShellIPhoneShell.swift — iPhone top-level shell, lifted out of
// AppShell.swift as part of the multi-PR split tracked in #123 (slice 6).
//
// What's in here:
//   • `AppShellIPhoneShell` — the iPhone `adaptiveShell` (drawer overlay
//     wrapping a NavigationStack-hosted center column) plus the Info and
//     Settings sheets that hang off it. The drawer-stay-open + tap-outside-
//     dismiss behaviour lives inside `AppShellIPhoneDrawer`; this struct
//     just composes the drawer, the center column, the iPhone-specific
//     toolbar items, and the iPhone-specific sheets.
//
// State surface: the iPhone shell takes a pre-built `sharedSidebar`
// (`AppShellSidebar`) plus the same bindings + closures the Mac shell
// gets, and one extra pair of iPhone-only flags (`iPhoneInfoSheet` for
// the Info detail sheet, `showSettings` reused from the Mac path). Wiring
// the iPhone-only toolbar items (hamburger + Info) is delegated to
// `AppShellIPhoneToolbar`; the shared Browse/Full-image content is taken
// as a `toolbarContent` builder so the call site can hand in
// `browseToolbarContent` unchanged.

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
    // Settings sheet — same flag as the Mac shell reuses; on iPhone it
    // presents with `.large` detents instead of a fixed window frame.
    @Binding var showSettings: Bool

    // Center-column state — forwarded straight to `AppShellCenterColumn`.
    let cloudTimelineVM: CloudTimelineViewModel?
    let cloudTimelineThumbClient: CloudThumbClient?
    let cloudTimelineThumbCache: CloudThumbCache?
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
            mainContent: {
                NavigationStack {
                    iPhoneMain
                }
                .accentColor(MapleTokens.primary)
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
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .presentationDetents([.large])
        }
    }

    @ViewBuilder
    private var iPhoneMain: some View {
        AppShellCenterColumn(
            isFullImage: mode == .fullImage,
            selectedSession: selectedSession,
            cloudTimelineVM: cloudTimelineVM,
            cloudTimelineThumbClient: cloudTimelineThumbClient,
            cloudTimelineThumbCache: cloudTimelineThumbCache,
            browseDisplayMode: $browseDisplayMode,
            browseVM: browseVM,
            sessions: $sessions,
            onSelectCloudAsset: onSelectCloudAsset,
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
