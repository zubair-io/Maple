// AppShellMacLayout.swift — Mac/iPad NavigationSplitView layout, lifted
// out of AppShell.swift as part of the multi-PR split tracked in #123
// (slice 4). The BrowseGrid / CloudTimelineView / editor switch was
// further extracted to `AppShellCenterColumn` in slice 5 (so the
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
    /// True iff an image is open (either Preview or the S5 editor). Read-only
    /// — the back chevron in `AppShellToolbar` writes `mode = .browse` via its
    /// `onBack` closure on AppShell. Drives the three-column (DetailPanel)
    /// layout vs the two-column browse layout.
    let isFullImage: Bool
    /// When true the center column renders the fast static `PreviewView`
    /// (Fast Preview §1) — a two-leg split (sidebar + full-bleed preview, no
    /// inspector; Preview owns its own Flag/Info surfaces) — rather than the
    /// S5 `EditorView`. Only meaningful while `isFullImage` is true.
    let usePreview: Bool
    @Binding var columnVisibility: NavigationSplitViewVisibility
    /// Whether the S5 editor's Info inspector is shown (#875 item 2). Only
    /// meaningful when `isFullImage` is true and `usePreview` is false —
    /// drives `.inspector(isPresented:)` on the editor's center column.
    @Binding var editorDetailVisible: Bool
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
    /// S5 EditorView dismiss (back to browse) — #815.
    let onEditorDismiss: () -> Void
    /// S5 EditorView share affordance — wired to the desktop ExportPanel.
    let onEditorShare: () -> Void
    /// S5 EditorView Info affordance — reveals the DetailPanel column.
    let onEditorInfo: () -> Void
    /// Preview's Edit button — flips the pane shell to `mode = .editing`.
    /// Fast Preview §1.
    var onPreviewEdit: (AssetRef) -> Void = { _ in }
    /// Preview's back button — returns to the browse grid (`mode = .browse`).
    /// Fast Preview §1.
    var onPreviewDismiss: () -> Void = {}
    /// M2: called when the user taps "Merge to Panorama…" from BrowseGrid
    /// (forwarded from AppShellCenterColumn → BrowseGrid → PanoSelectionBar).
    var onMergePanorama: (() -> Void)? = nil
    /// M4: called when the user taps "Edit Metadata…" from BrowseGrid
    /// (forwarded from AppShellCenterColumn → BrowseGrid → PanoSelectionBar).
    var onEditMetadata: (() -> Void)? = nil

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

    @ViewBuilder
    private var fullImage: some View {
        if usePreview {
            previewFullImage
        } else {
            editorFullImage
        }
    }

    /// Fast Preview pane shell (Fast Preview §1). Two-leg split: sidebar +
    /// full-bleed `PreviewView`, no persistent inspector — Preview owns its own
    /// Flag popover + Info panel. Mirrors `editorFullImage`'s shape (which also
    /// drops the third nav column) so the center subtree stays a plain content
    /// column.
    private var previewFullImage: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            sidebar()
                .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 280)
        } detail: {
            centerColumn
                // Preview ships its own 44pt header (back + filename), so
                // suppress the navigation title to avoid a duplicate.
                .navigationTitle("")
                .toolbar { toolbarContent() }
        }
        .navigationSplitViewStyle(.balanced)
    }

    /// S5 editor pane shell (#815 / #875). The Info inspector is a
    /// toggleable `.inspector(isPresented:)` on the center column rather
    /// than a persistent `detail:` column — so the editor's `(i)` button
    /// can show/hide it, and toggling never changes the center subtree's
    /// identity (the `EditorSessionHost`'s `@State` armed-tool / fine-mode
    /// survives, #816). Two-leg split (sidebar + content); the inspector
    /// floats over / beside the content without being a third nav column.
    private var editorFullImage: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            sidebar()
                .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 280)
        } detail: {
            centerColumn
                // The EditorView's own PillHeader shows the filename, so
                // suppress the navigation title to avoid a duplicate
                // (notably the inline title on iPad).
                .navigationTitle("")
                .toolbar { toolbarContent() }
                .inspector(isPresented: $editorDetailVisible) {
                    DetailPanel(session: selectedSession)
                        // `.inspectorColumnWidth` is the inspector analogue
                        // of `navigationSplitViewColumnWidth` — clamps the
                        // Info rail to a sensible macOS width.
                        .inspectorColumnWidth(min: 240, ideal: 280, max: 360)
                }
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
            usePreview: usePreview,
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
            onEditorDismiss: onEditorDismiss,
            onEditorShare: onEditorShare,
            onEditorInfo: onEditorInfo,
            onPreviewEdit: onPreviewEdit,
            onPreviewDismiss: onPreviewDismiss,
            onMergePanorama: onMergePanorama,
            onEditMetadata: onEditMetadata
        )
    }
}
