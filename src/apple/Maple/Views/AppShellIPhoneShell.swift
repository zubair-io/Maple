// AppShellIPhoneShell.swift — iPhone top-level shell, lifted out of
// AppShell.swift as part of the multi-PR split tracked in #123 (slice 6).
//
// What's in here:
//   • `AppShellIPhoneShell` — the Library tab's center column + its
//     iPhone-specific toolbar items. The LIBRARY drawer that overlays the
//     whole tab view (footer + top bar, full device height) is hosted one
//     level up in `PhoneTabShell` (#692); this struct just renders the
//     center column.
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
// gets. Wiring the iPhone-only toolbar item (hamburger) is delegated
// to `AppShellIPhoneToolbar`; the shared Browse content is taken as a
// `toolbarContent` builder so the call site can hand in
// `browseToolbarContent` unchanged.
//
// This shell's center column only ever renders Browse — Preview and the S5
// editor are reached by pushing onto the Library tab's `NavigationStack`
// instead (`PhoneLibraryView`'s `.navigationDestination`), not by flipping
// `AppShell.mode`. The legacy `.fullImage` full-image loupe (the one mode
// this struct DID key off `mode` for) was retired in #1807, and the
// trailing-toolbar Info sheet that hung off it was removed in the #1826
// follow-up — `PreviewView` and the S5 editor (`EditorDestination`) each
// ship their own Info affordance now, reached via the Library tab's
// NavigationStack.

#if os(iOS)
import SwiftUI
import MapleCore

struct AppShellIPhoneShell<ToolbarContentT: ToolbarContent>: View {
    /// Drawer-snapped state; the hamburger writes this with a spring
    /// animation, the drawer reads it to decide rest-state.
    @Binding var isDrawerOpen: Bool
    /// Read straight off AppShell, forwarded to the drawer (which gates
    /// edge-open on `.browse`). This shell's own content is always Browse —
    /// Preview / editor are pushed onto the Library tab's NavigationStack
    /// instead, so `mode` never reaches `.preview` / `.editing` here.
    let mode: AppShell.Mode
    /// Active EditSession forwarded to `AppShellCenterColumn`.
    let selectedSession: EditSession?
    /// Title shown in the navigation bar.
    let libraryTitle: String

    // Center-column state — forwarded straight to `AppShellCenterColumn`.
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
    let previewTransitionNamespace: Namespace.ID

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
    /// #944: app-level copy/paste/sync-adjustments clipboard, forwarded
    /// through to BrowseGrid via AppShellCenterColumn.
    var clipboard: AdjustmentClipboard? = nil

    var body: some View {
        // The LIBRARY drawer is hosted one level up, in `PhoneTabShell`, so it
        // overlays the whole tab view (footer + top bar) at full device height
        // (#692). This struct just renders the Library tab's center column +
        // its toolbar; the surrounding `PhoneTabShell` provides the per-tab
        // NavigationStack and the drawer.
        iPhoneMain
        // Settings sheet dropped in responsive-program S1a (#597) — Settings
        // is now a top-level tab in PhoneTabShell.
    }

    @ViewBuilder
    private var iPhoneMain: some View {
        AppShellCenterColumn(
            // Always Browse — see the file header. `AppShellCenterColumn`'s
            // Preview / editor branches are unreachable from this shell.
            isFullImage: false,
            selectedSession: selectedSession,
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
            previewTransitionNamespace: previewTransitionNamespace,
            onSelectCloudAsset: onSelectCloudAsset,
            onCloseSearch: onCloseSearch,
            onSelectLocalAsset: onSelectLocalAsset,
            onGrantPhotosAccess: onGrantPhotosAccess,
            onNavigateFolder: onNavigateFolder,
            onOpenEditor: onOpenEditor,
            onPrimeSession: onPrimeSession,
            onFullImageFallback: onFullImageFallback,
            onMergePanorama: onMergePanorama,
            onEditMetadata: onEditMetadata,
            clipboard: clipboard
        )
        .navigationTitle(libraryTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            AppShellIPhoneToolbar(
                isBrowse: mode == .browse,
                isDrawerOpen: $isDrawerOpen
            )
            toolbarContent()
        }
    }
}
#endif
