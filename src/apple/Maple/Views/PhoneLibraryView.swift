// PhoneLibraryView.swift — content for the Library tab of the iPhone
// tab-bar shell (responsive-program S1a, #597; S2, #623).
//
// Thin wrapper around the existing `AppShellIPhoneShell` (drawer-over-
// center-column). The center column renders the S2 `LibraryGrid`
// (responsive 3-col edge-bleed on phone) via `AppShellCenterColumn`'s
// layout-aware switch — the original "stub" placeholder text has been
// retired.
//
// We also implement the **tab-bar hide on push** contract: a Library
// cell tap appends `.preview(asset)` to `PhoneTabShell`'s `libraryPath`,
// which the tab's `NavigationStack(path:)` pushes and the
// `.navigationDestination(for: LibraryDestination.self)` here resolves.
// Both cases call `.toolbar(.hidden, for: .tabBar)` so the bottom tab
// bar disappears for the duration (#625, #791). The modifier pattern is
// the contract that all push destinations in the phone shell follow.
//
// Fast Preview epic (§1): a grid tap now lands on `.preview` (the fast
// static Preview surface); Preview's Edit button appends `.edit` to the
// SAME `libraryPath` (→ `EditorDestination → EditorView`). Back stack is
// `grid → Preview → Editor`; each back pops one level.

#if os(iOS)

import SwiftUI
import MapleCore
import UIKit

struct PhoneLibraryView<ToolbarContentT: ToolbarContent>: View {
    @Namespace private var previewTransition
    @Binding var isDrawerOpen: Bool
    let mode: AppShell.Mode
    let selectedSession: EditSession?
    let libraryTitle: String

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
    /// The Library tab's navigation stack (owned by `PhoneTabShell`). Preview's
    /// Edit button appends `.edit(asset)` to it, so this view needs write access
    /// to push the editor from inside the resolved `.preview` destination.
    @Binding var libraryPath: [LibraryDestination]

    let toolbarContent: () -> ToolbarContentT

    let onSelectCloudAsset: (SearchAsset, URL) -> Void
    /// `CloudSource` for a cloud asset pushed from the Timeline / merged grid.
    /// Preferred over `browseVM.currentSource`, which is nil for those taps —
    /// Preview needs a source or it falls back to downloading the RAW (#2376).
    var cloudPreviewSource: (any ImageSource)? = nil
    let onCloseSearch: () -> Void
    let onSelectLocalAsset: (ImageRef) -> Void
    let onGrantPhotosAccess: () -> Void
    let onNavigateFolder: (URL) -> Void
    let onOpenEditor: (AssetRef) -> Void
    let onPrimeSession: (AssetRef) -> Void
    let onFullImageFallback: () -> Void
    /// Resolves the iPhone Preview sibling list for a Timeline-opened asset
    /// (#2299) — the currently-loaded Timeline VM's ordered cells, with the
    /// pushed `ref` itself spliced in at its own position. Empty-VM cases
    /// (no Timeline active) return `[]`, so `.navigationDestination` below
    /// falls back to `browseVM.assets` / `[ref]` as before.
    let timelinePreviewSiblingAssets: (AssetRef) -> [AssetRef]
    /// M2: opens the panorama merge view when the user taps "Merge to Panorama…".
    var onMergePanorama: (() -> Void)? = nil
    /// M4: opens the batch metadata editor when the user taps "Edit Metadata…".
    var onEditMetadata: (() -> Void)? = nil
    /// #944: app-level copy/paste/sync-adjustments clipboard, forwarded
    /// through to BrowseGrid via AppShellIPhoneShell.
    var clipboard: AdjustmentClipboard? = nil

    var body: some View {
        AppShellIPhoneShell(
            isDrawerOpen: $isDrawerOpen,
            mode: mode,
            selectedSession: selectedSession,
            libraryTitle: libraryTitle,
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
            previewTransitionNamespace: previewTransition,
            toolbarContent: toolbarContent,
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
        // Tab-bar hide-on-push contract for the phone shell (#625/#791).
        // Fast Preview epic §1: a grid / cloud-result tap pushes `.preview`
        // (the fast static surface); Preview's Edit pushes `.edit` onto the
        // same stack. Both hide the tab bar + system nav bar (each ships its
        // own 44pt header with a back button → `dismiss()`).
        .navigationDestination(for: LibraryDestination.self) { destination in
            Group {
                switch destination {
                case .preview(let ref):
                    PreviewDestination(
                        asset: ref,
                        // Snapshot the current folder's assets at push time so
                        // the filmstrip + prev/next have the sibling list. The
                        // local library flow carries the full `browseVM.assets`;
                        // a Timeline tap (#2299) leaves `browseVM` empty, so
                        // fall back to that Timeline VM's own already-loaded
                        // ordered cells (`timelinePreviewSiblingAssets` splices
                        // `ref` itself in at its matching position). A search
                        // result (neither) still degrades to the single-asset
                        // `[ref]` `timelinePreviewSiblingAssets` returns when it
                        // finds no sibling list either.
                        assets: browseVM.assets.contains(ref)
                            ? browseVM.assets
                            : timelinePreviewSiblingAssets(ref),
                        source: browseVM.currentSource ?? cloudPreviewSource,
                        sessions: $sessions,
                        onClose: popPreviewWithoutAnimation,
                        onEdit: { asset in libraryPath.append(.edit(asset)) },
                        onSelectionChanged: { asset in
                            browseVM.selectedID = asset.id
                            // Prime the REAL session (with a CloudSidecarStore
                            // for a Timeline-sourced cloud sibling — see
                            // `AssetRef.thumbnailProvenance` / `ensureSession`)
                            // the moment a lazily-built sibling becomes the
                            // shown asset, so a later Edit tap on it reuses a
                            // fully-wired session instead of EditorDestination's
                            // bare no-remote-store fallback. No-ops if a
                            // session already exists (idempotent, matches
                            // `onPrimeSession`'s existing BrowseGrid contract).
                            onPrimeSession(asset)
                        }
                    )
                case .edit(let ref):
                    EditorDestination(asset: ref, sessions: $sessions)
                }
            }
            .toolbar(.hidden, for: .tabBar)
            .toolbar(.hidden, for: .navigationBar)
        }
    }

    private func popPreviewWithoutAnimation() {
        guard !libraryPath.isEmpty else { return }
        var transaction = Transaction()
        transaction.disablesAnimations = true
        UIView.performWithoutAnimation {
            withTransaction(transaction) {
                _ = libraryPath.removeLast()
            }
        }
    }
}

#endif
