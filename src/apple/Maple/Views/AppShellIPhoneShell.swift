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
    /// Non-nil while the sidebar's MAP row (#2830, `.map` selection) is
    /// current — forwarded straight through to `AppShellCenterColumn`, same
    /// three values `AppShellMacLayout` gets from the Mac/iPad sidebar's MAP
    /// row. #2886: this is now the ONLY iPhone call site for these — the
    /// Map tab's independent `AppShellCenterColumn` call site (#2878) is
    /// gone, since Map lives in the side navigation, not the tab bar.
    let mapVM: MapViewModel?
    let mapThumbClient: CloudThumbClient?
    let mapThumbCache: CloudThumbCache?
    /// Why `.map` has no `mapVM` yet (#2848) — forwarded straight through
    /// to `AppShellCenterColumn`'s `MapEmptyState`. `nil` whenever `mapVM`
    /// is set or `.map` isn't selected; see `AppShell.mapUnavailableReason`.
    let mapUnavailableReason: MapUnavailableReason?
    @Binding var browseDisplayMode: GridDisplayMode
    let browseVM: BrowseViewModel
    @Binding var sessions: [AssetRef.ID: EditSession]
    let previewTransitionNamespace: Namespace.ID

    /// Pre-built shared toolbar content — composed alongside the iPhone-
    /// only hamburger + Info items inside the NavigationStack's `.toolbar`.
    let toolbarContent: () -> ToolbarContentT

    // Center-column callbacks — all forward into AppShell action methods.
    let onSelectCloudAsset: (SearchAsset, URL) -> Void
    /// Map pin/cluster tap (#2830) → AppShell activates search filtered by
    /// the resolved target (a place name, or the has-GPS scope fallback);
    /// on iPhone this seeds the Search tab rather than the mac/iPad overlay
    /// (#3163) — see `AppShell+Map.swift.selectMapPlace`.
    let onSelectMapPlace: (MapPlaceSearchTarget) -> Void
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
    /// #2641: called when the user taps "Batch Rename…" from PanoSelectionBar.
    var onBatchRename: (() -> Void)? = nil
    /// #2653: Delete key / "Move to Trash" context-menu item, forwarded
    /// through to BrowseGrid via AppShellCenterColumn.
    var onTrashAssets: (([AssetRef.ID]) -> Void)? = nil
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
            mapVM: mapVM,
            mapThumbClient: mapThumbClient,
            mapThumbCache: mapThumbCache,
            mapUnavailableReason: mapUnavailableReason,
            // The iPhone shell never shows the mac/iPad search overlay
            // (#3163) — its search surface is the Search tab
            // (`PhoneSearchTab`, wired one level up in `PhoneTabShell`).
            isSearchActive: false,
            searchVM: nil,
            searchThumbClient: nil,
            searchThumbCache: nil,
            browseDisplayMode: $browseDisplayMode,
            browseVM: browseVM,
            sessions: $sessions,
            previewTransitionNamespace: previewTransitionNamespace,
            onSelectCloudAsset: onSelectCloudAsset,
            onSelectMapPlace: onSelectMapPlace,
            // `isSearchActive` is always false above, so `CloudSearchView`
            // never mounts here and never calls this — required by
            // `AppShellCenterColumn`'s init but otherwise dead on iPhone.
            onCloseSearch: {},
            onSelectLocalAsset: onSelectLocalAsset,
            onGrantPhotosAccess: onGrantPhotosAccess,
            onNavigateFolder: onNavigateFolder,
            onOpenEditor: onOpenEditor,
            onPrimeSession: onPrimeSession,
            onFullImageFallback: onFullImageFallback,
            onMergePanorama: onMergePanorama,
            onEditMetadata: onEditMetadata,
            onBatchRename: onBatchRename,
            onTrashAssets: onTrashAssets,
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
