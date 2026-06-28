// AppShellCenterColumn.swift — shared center-column body for the
// Mac/iPad NavigationSplitView and the iPhone NavigationStack.
//
// Lifted out of AppShell.swift / AppShellMacLayout.swift as part of the
// multi-PR split tracked in #123 (slice 5, final). Pre-slice-5 the same
// BrowseGrid / CloudTimelineView / FullImageView switch lived once in
// `AppShellMacLayout.centerColumn` and once in `AppShell.iPhoneMain`,
// drifting independently. Centralising it means only one place renders
// the three center views, and only one set of bindings + callbacks
// needs to be maintained.
//
// State surface: the view is pure-presentation — every callback below
// forwards into an AppShell action method (or, on Mac, into the layout
// struct that wraps this view). The struct does not know about cloud-
// tokens, security-scope, or sidebar callbacks.

import SwiftUI
import MapleCore

struct AppShellCenterColumn: View {
    /// Layout density signal from AppShell. The iPhone shell renders the
    /// responsive S2 `LibraryGrid`; iPad / Mac keep the mature
    /// `BrowseGrid` (folders, error banner, keyboard shortcuts) to avoid
    /// regressing desktop behaviour in this PR.
    @Environment(\.mapleLayout) private var layout

    /// True iff an image is open (either editor mode). The view renders
    /// an image surface in that case; otherwise it renders the explorer
    /// grid (or the cloud timeline, when one is active).
    let isFullImage: Bool
    /// When true (and `isFullImage`) the image surface is the S5
    /// `EditorView`; otherwise the legacy `FullImageView` (#815).
    /// Defaults to `false` so the iPhone shell — which renders
    /// `FullImageView` via `isFullImage` and never enters the desktop
    /// `.editing` mode — is unchanged.
    var useEditor: Bool = false
    let selectedSession: EditSession?
    let cloudTimelineVM: CloudTimelineViewModel?
    let cloudTimelineThumbClient: CloudThumbClient?
    let cloudTimelineThumbCache: CloudThumbCache?
    /// When true (and the search VM + thumb client/cache are present) the
    /// center column renders `CloudSearchView` instead of the grid /
    /// timeline. Takes precedence over the timeline branch but not the
    /// full-image editor.
    let isSearchActive: Bool
    let searchVM: SearchViewModel?
    let searchThumbClient: CloudThumbClient?
    let searchThumbCache: CloudThumbCache?
    @Binding var browseDisplayMode: GridDisplayMode
    let browseVM: BrowseViewModel
    @Binding var sessions: [AssetRef.ID: EditSession]

    // Center-column callbacks — forward into AppShell action methods.
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
    /// S5 EditorView dismiss (back to browse). Only used when
    /// `useEditor` is true; defaults to no-op so the iPhone shell needn't
    /// supply it. #815.
    var onEditorDismiss: () -> Void = {}
    /// S5 EditorView share affordance. Only used when `useEditor` is
    /// true; defaults to no-op. #815.
    var onEditorShare: () -> Void = {}
    /// S5 EditorView Info affordance (reveals the DetailPanel column).
    /// Only used when `useEditor` is true; defaults to no-op. #815.
    var onEditorInfo: () -> Void = {}
    /// Called when the user taps "Merge to Panorama…" from the BrowseGrid
    /// multi-select action bar (M2, #1236). nil suppresses the bar.
    var onMergePanorama: (() -> Void)? = nil
    /// Called when the user taps "Edit Metadata…" from the BrowseGrid
    /// multi-select action bar (M4, #1629). nil hides the button.
    var onEditMetadata: (() -> Void)? = nil

    var body: some View {
        // The center column switches between the explorer grid (browse
        // mode) and the full-image editor (fullImage mode). Per the
        // mockup, these are two different center views — not a
        // side-by-side. Double-click on a thumbnail flips the mode.
        if isFullImage {
            if let session = selectedSession {
                if useEditor {
                    // S5 EditorView in the Mac/iPad pane shell (#815).
                    // Hosted by `EditorSessionHost` so the `EditorState`
                    // lives in `@State` for the editor's lifetime — building
                    // it inline would reset armed-tool / fine-mode on every
                    // SwiftUI re-render. The filmstrip is wired from the
                    // browse VM's current asset list so siblings are
                    // tappable, matching the editor's filmstrip contract.
                    EditorSessionHost(
                        session: session,
                        filmstripAssets: browseVM.assets,
                        filmstripSource: browseVM.currentSource,
                        onDismiss: onEditorDismiss,
                        onShare: onEditorShare,
                        onInfo: onEditorInfo,
                        onSelectAsset: onOpenEditor
                    )
                } else {
                    FullImageView(session: session)
                }
            } else {
                // Fallback — if the session vanished while editing,
                // drop back to browse.
                Color.clear.onAppear { onFullImageFallback() }
            }
        } else if isSearchActive,
                  let svm = searchVM,
                  let thumbClient = searchThumbClient,
                  let thumbCache = searchThumbCache {
            CloudSearchView(
                vm: svm,
                thumbClient: thumbClient,
                thumbCache: thumbCache,
                displayMode: browseDisplayMode,
                onSelectAsset: { asset in onSelectCloudAsset(asset, svm.server) },
                onClose: onCloseSearch
            )
        } else {
            if let vm = cloudTimelineVM,
               let thumbClient = cloudTimelineThumbClient,
               let thumbCache = cloudTimelineThumbCache {
                CloudTimelineView(
                    vm: vm,
                    thumbClient: thumbClient,
                    thumbCache: thumbCache,
                    displayMode: browseDisplayMode,
                    onSelectAsset: { asset in onSelectCloudAsset(asset, vm.server) },
                    onSelectLocalAsset: onSelectLocalAsset
                )
            } else {
                // Responsive-program S2 (#623): on phone, the Library tab
                // renders the new responsive 3-col edge-bleed grid with
                // filter chips. iPad / Mac keep BrowseGrid for now to
                // preserve folder navigation, the error banner, and the
                // existing keyboard-cull shortcuts. The two share the
                // `LibraryCell` thumbnail component so visual chrome stays
                // consistent. A follow-up will unify the tablet / desktop
                // paths onto `LibraryGrid`.
                #if os(iOS)
                if layout == .phone {
                    LibraryGrid(
                        vm: browseVM,
                        source: browseVM.currentSource,
                        sessions: $sessions,
                        displayMode: $browseDisplayMode,
                        onOpenEditor: onOpenEditor,
                        onPrimeSession: onPrimeSession,
                        onNavigateFolder: onNavigateFolder
                    )
                } else {
                    BrowseGrid(
                        vm: browseVM,
                        sessions: $sessions,
                        displayMode: $browseDisplayMode,
                        onGrantPhotosAccess: onGrantPhotosAccess,
                        onNavigateFolder: onNavigateFolder,
                        onOpenEditor: onOpenEditor,
                        onPrimeSession: onPrimeSession,
                        onMergePanorama: onMergePanorama,
                        onEditMetadata: onEditMetadata
                    )
                }
                #else
                BrowseGrid(
                    vm: browseVM,
                    sessions: $sessions,
                    displayMode: $browseDisplayMode,
                    onGrantPhotosAccess: onGrantPhotosAccess,
                    onNavigateFolder: onNavigateFolder,
                    onOpenEditor: onOpenEditor,
                    onPrimeSession: onPrimeSession,
                    onMergePanorama: onMergePanorama,
                    onEditMetadata: onEditMetadata
                )
                #endif
            }
        }
    }
}
