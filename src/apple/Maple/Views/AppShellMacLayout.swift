// AppShellMacLayout.swift — Mac/iPad NavigationSplitView layout, lifted
// out of AppShell.swift as part of the multi-PR split tracked in #123
// (slice 4). The BrowseGrid / CloudTimelineView / FullImageView switch
// was further extracted to `AppShellCenterColumn` in slice 5 (so the
// iPhone NavigationStack and the Mac NavigationSplitView share one
// definition).
//
// What's in here:
//   • `AppShellMacLayout` — the top-level `macShell` switch (Browse vs
//     Full-image) plus the two flavours of `NavigationSplitView`
//     (`fullImage`, `browse`). The center column itself lives in
//     `AppShellCenterColumn.swift`.
//
// State surface (kept deliberately small): the layout struct receives a
// pre-built sidebar (`AppShellSidebar`) plus the small set of bindings
// it needs to drive the toolbar + content switch. Everything else lives
// on AppShell — this struct does not need to know about cloud-tokens,
// security-scope, or sidebar callbacks.

import SwiftUI
import MapleCore

struct AppShellMacLayout<SidebarContent: View, ToolbarContentT: ToolbarContent>: View {
    /// True iff AppShell is in Full-image mode. Read-only — the back
    /// chevron in `AppShellToolbar` writes `mode = .browse` via its
    /// `onBack` closure on AppShell.
    let isFullImage: Bool
    @Binding var columnVisibility: NavigationSplitViewVisibility
    let libraryTitle: String
    let selectedSession: EditSession?
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
    /// Pre-built sidebar — both NavigationSplitView legs render this.
    let sidebar: () -> SidebarContent
    /// Pre-built toolbar — wired to AppShell state in the parent.
    let toolbarContent: () -> ToolbarContentT

    // Center-column callbacks — these all forward into AppShell action
    // methods (see AppShell+FolderActions / AppShell+CloudActions /
    // AppShell+PhotoKitActions). Centralising them here keeps the layout
    // pure-presentation and lets AppShell own all state mutation.
    let onSelectCloudAsset: (SearchAsset, URL) -> Void
    /// Dismiss the cloud search UI.
    let onCloseSearch: () -> Void
    let onSelectLocalAsset: (ImageRef) -> Void
    let onGrantPhotosAccess: () -> Void
    let onNavigateFolder: (URL) -> Void
    let onOpenEditor: (AssetRef) -> Void
    let onPrimeSession: (AssetRef) -> Void
    /// Recover from a vanished selection by flipping back to Browse.
    let onFullImageFallback: () -> Void

    var body: some View {
        // In Browse mode the detail panel is suppressed entirely — the
        // explorer grid takes the full content area. In Full-image mode
        // the panel comes back as the third column for Develop + Info.
        // We switch the NavigationSplitView column count rather than
        // collapsing the detail to zero width, because SwiftUI still
        // reserves space for an empty detail column.
        if isFullImage {
            fullImage
        } else {
            browse
        }
    }

    private var fullImage: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            sidebar()
                .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 280)
        } content: {
            centerColumn
                .navigationSplitViewColumnWidth(min: 300, ideal: 520)
                .navigationTitle(selectedSession?.asset.displayName ?? "Image")
                .toolbar { toolbarContent() }
        } detail: {
            // `isFullImage` drives Ticket 12 bugs 4/5/8: the panel auto-flips
            // to Develop on entry, back to Info on exit. Width: iPad expands
            // the column toward `max` (~half the screen when balanced), so
            // DetailPanelWidth tightens the range there to just fit the
            // slider rail. macOS keeps the original range.
            DetailPanel(session: selectedSession, isFullImage: true)
                .modifier(DetailPanelWidth())
        }
        .navigationSplitViewStyle(.balanced)
    }

    private var browse: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            sidebar()
                .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 280)
        } detail: {
            centerColumn
                .navigationTitle("Library — \(libraryTitle)")
                .toolbar { toolbarContent() }
        }
        .navigationSplitViewStyle(.balanced)
    }

    private var centerColumn: AppShellCenterColumn {
        AppShellCenterColumn(
            isFullImage: isFullImage,
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
    }
}
