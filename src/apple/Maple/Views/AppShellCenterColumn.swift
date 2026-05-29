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

    /// True iff AppShell is in Full-image mode. The view renders the
    /// editor in that case; otherwise it renders the explorer grid (or
    /// the cloud timeline, when one is active).
    let isFullImage: Bool
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
    /// Active source label (e.g. "France trip"). Drives the in-content
    /// header on the phone `LibraryGrid` — desktop / iPad still use the
    /// nav-bar title, so this parameter is optional with a sensible
    /// default for callers that haven't been updated to thread it.
    var libraryTitle: String = "Library"
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

    var body: some View {
        // The center column switches between the explorer grid (browse
        // mode) and the full-image editor (fullImage mode). Per the
        // mockup, these are two different center views — not a
        // side-by-side. Double-click on a thumbnail flips the mode.
        if isFullImage {
            if let session = selectedSession {
                FullImageView(session: session)
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
                        title: libraryTitle,
                        sessions: $sessions,
                        displayMode: $browseDisplayMode,
                        onOpenEditor: onOpenEditor,
                        onPrimeSession: onPrimeSession
                    )
                } else {
                    BrowseGrid(
                        vm: browseVM,
                        sessions: $sessions,
                        displayMode: $browseDisplayMode,
                        onGrantPhotosAccess: onGrantPhotosAccess,
                        onNavigateFolder: onNavigateFolder,
                        onOpenEditor: onOpenEditor,
                        onPrimeSession: onPrimeSession
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
                    onPrimeSession: onPrimeSession
                )
                #endif
            }
        }
    }
}
