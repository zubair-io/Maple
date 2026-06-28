// AppShellIPhoneShell.swift — iPhone top-level shell, lifted out of
// AppShell.swift as part of the multi-PR split tracked in #123 (slice 6).
//
// What's in here:
//   • `AppShellIPhoneShell` — the Library tab's center column + its
//     iPhone-specific toolbar items, plus the Info sheet that hangs off
//     it. The LIBRARY drawer that overlays the whole tab view (footer +
//     top bar, full device height) is hosted one level up in
//     `PhoneTabShell` (#692); this struct just renders the center column.
//
// Responsive-program S1a (#597): Settings used to be a modal sheet
// presented from this shell. Settings is now a top-level tab in
// `PhoneTabShell`, so the `showSettings` binding + `.sheet` wiring
// have been removed. This struct is also no longer mounted from
// `AppShell.body` directly — `PhoneLibraryView` (the Library tab's
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

struct AppShellIPhoneShell<ToolbarContentT: ToolbarContent>: View {
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
    /// M2: called when the user taps "Merge to Panorama…" from PanoSelectionBar.
    var onMergePanorama: (() -> Void)? = nil
    /// M4: called when the user taps "Edit Metadata…" from PanoSelectionBar.
    var onEditMetadata: (() -> Void)? = nil

    var body: some View {
        // The LIBRARY drawer is hosted one level up, in `PhoneTabShell`, so it
        // overlays the whole tab view (footer + top bar) at full device height
        // (#692). This struct just renders the Library tab's center column +
        // its toolbar; the surrounding `PhoneTabShell` provides the per-tab
        // NavigationStack and the drawer.
        iPhoneMain
        .sheet(isPresented: $iPhoneInfoSheet) {
            NavigationStack {
                DetailPanel(session: selectedSession)
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
            onFullImageFallback: onFullImageFallback,
            onMergePanorama: onMergePanorama,
            onEditMetadata: onEditMetadata
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
