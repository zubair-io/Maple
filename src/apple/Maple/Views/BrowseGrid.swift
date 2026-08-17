// BrowseGrid.swift — Lazy thumbnail grid for the Browse column.
//
// Mac/iPad: column in NavigationSplitView. iPhone: main view in TabView.
// Supports selection, keyboard culling (stars 1-5, P/X flags, arrow nav).
//
// M1b (#1490): migrated onto the shared PhotoGrid / PhotoThumbnailCell /
// ThumbnailProvider. The inline LazyVGrid / ForEach body + MergedCellView
// are replaced; FolderCell / FolderCellButtonStyle / ErrorBanner /
// keyboard shortcuts are kept unchanged.
//
// #2924: `BrowseEmptyState` moved to its own file so the iPhone's
// `LibraryGrid` can render the same overlay — it was `private` here, and
// phone consequently had no empty state at all.

import SwiftUI
import MapleCore
#if os(macOS)
import AppKit
#endif

// MARK: - GridDisplayMode
// Moved to Maple/Views/Grid/ThumbnailImage.swift (#1490 M0).

// MARK: - BrowseGrid View

struct BrowseGrid: View {
    /// Injected from `AppShell`. `BrowseViewModel` is `@Observable`, so we
    /// receive the instance directly — no observed-object wrapper needed.
    let vm: BrowseViewModel
    @Binding var sessions: [AssetRef.ID: EditSession]
    /// How image cells render their thumbnails. Owned by the parent shell so
    /// the toolbar toggle survives BrowseGrid view re-creation. Defaults to
    /// `.fill` when the parent doesn't pass a binding.
    var displayMode: Binding<GridDisplayMode>? = nil
    /// Fired by the empty state's "Grant Access" button when
    /// `vm.photosAuthNeeded` is true. `nil` in previews / non-Photos flows.
    var onGrantPhotosAccess: (() -> Void)? = nil
    /// Single-click on a sub-folder cell. Shell navigates the explorer into
    /// that folder (claims security scope + reloads the grid).
    var onNavigateFolder: ((URL) -> Void)? = nil
    /// Security-scope bookmark of the currently-browsed local folder — the
    /// ancestor every sub-folder tile in `vm.subfolders` is a CHILD of.
    /// Threaded straight from `AppShell`'s `currentRootBookmark`, the same
    /// value the sidebar's `FolderTreeRow` re-claims scope from at any
    /// depth (#2779). `vm.subfolders` is only ever populated by local
    /// filesystem browsing (`BrowseViewModel.loadFolder`) — PhotoKit/SMB/
    /// Cloud sources never set it — so `nil` here (no local folder open)
    /// naturally also means no folder tiles are on screen to drop onto.
    var currentRootBookmark: Data? = nil
    /// Drop-onto-folder-tile (#2779). Same signature as
    /// `LibrarySidebar.onDropAssets` and routed by `AppShell` into the
    /// SAME `handleAssetDrop` entry point the sidebar's `FolderTreeRow`
    /// uses — not a forked copy — so eligibility rules (PhotoKit excluded,
    /// cross-source-kind rejected, same-folder-drop rejected as
    /// `FileOperationError.sameFile`) and the Option-to-copy / collision
    /// flow are identical between the two drop surfaces. `nil` disables
    /// drop-onto-tile entirely (e.g. previews).
    var onDropAssetsOnFolder: ((URL, Data, Set<AssetRef.ID>?, Bool) -> Void)? = nil
    /// Double-click on an image cell. Shell switches into Full-image / Edit
    /// mode with that asset as the active session.
    var onOpenEditor: ((AssetRef) -> Void)? = nil
    /// Called from each thumbnail cell's `.onAppear`. Used by AppShell to
    /// lazily create per-asset `EditSession`s only when their cell scrolls
    /// into view, instead of eagerly priming every asset in the folder.
    var onPrimeSession: ((AssetRef) -> Void)? = nil
    /// Fired when the user taps "Merge to Panorama…" from the selection bar
    /// (≥2 assets selected). `nil` suppresses the bar entirely (e.g. previews).
    var onMergePanorama: (() -> Void)? = nil
    /// Fired when the user taps "Edit Metadata…" from the selection bar.
    /// `nil` hides the button; the bar itself is still shown when `onMergePanorama` is set.
    var onEditMetadata: (() -> Void)? = nil
    /// Fired when the user taps "Batch Rename…" from the selection bar
    /// (#2641). `nil` hides the button.
    var onBatchRename: (() -> Void)? = nil
    /// Delete key / "Move to Trash" context-menu item (#2653). Fires with
    /// the currently-active selection (multi-select checked set, or just
    /// the focused single asset). `nil` disables both the Delete-key
    /// shortcut and the per-cell context-menu item — e.g. previews, the
    /// merged timeline (no grid selection concept there).
    var onTrashAssets: (([AssetRef.ID]) -> Void)? = nil
    /// App-level copy/paste/sync-adjustments clipboard (#944). `nil` hides
    /// the selection bar's paste/sync buttons and disables the ⌘C/⌘V
    /// keyboard shortcuts (e.g. previews, where nothing is wired to write
    /// sidecars).
    var clipboard: AdjustmentClipboard? = nil
    /// Cloud thumb infrastructure for merged mode. When nil (the default),
    /// cloud-only merged cells fall through to `ThumbnailLoader.shared`
    /// (same behaviour as the old MergedCellView's cloud-only path).
    var thumbClient: CloudThumbClient? = nil
    var thumbCache: CloudThumbCache? = nil
    /// Server cache-host key for merged-mode cloud thumbs. Used by
    /// `ThumbnailProvider` to namespace the disk cache per-server identically
    /// to the cloud timeline. Empty string when no cloud infra is wired.
    var mergedHost: String = ""

    /// Rename affordance (#2842). Read here (rather than only inside
    /// `GridCellRenameCaption`, which reads its own copy via inherited
    /// environment) because the context-menu closure below needs it too —
    /// `.contextMenu` content is built from a plain closure capture, not a
    /// `View` with its own `@Environment` access. `nil` in previews / flows
    /// that never inject the action (matches every other environment-action
    /// consumer in this file).
    @Environment(\.assetRename) private var assetRename

    /// Local fallback when no parent binding is supplied (e.g. previews).
    /// Real toolbar wiring lives on `AppShell`.
    @State private var localDisplayMode: GridDisplayMode = .fill

    /// Resolved mode — parent binding wins; otherwise the local @State.
    private var resolvedDisplayMode: GridDisplayMode {
        displayMode?.wrappedValue ?? localDisplayMode
    }

    /// True when the current folder has neither sub-folders nor images. The
    /// empty-state overlay only takes over in that case — otherwise we're
    /// browsing a populated folder.
    private var isEmpty: Bool {
        vm.assets.isEmpty && vm.subfolders.isEmpty
    }

    /// Thumbnail provider for normal (local) mode.
    @State private var localProvider = ThumbnailProvider.local()

    /// Drives the selective-paste sheet (#944) — a toggle per
    /// `AdjustmentGroup`, presented from the selection bar's "Paste
    /// Selected Groups…" button.
    @State private var showAdjustmentGroupPicker = false

    /// Thumbnail provider for merged mode. Built ONCE in `.task` when cloud infra
    /// is wired (not per body evaluation, per `ThumbnailProvider`'s "inject once
    /// per grid surface" guidance). `nil` until set / when no cloud infra — merged
    /// mode then falls back to `localProvider`.
    @State private var mergedProvider: ThumbnailProvider?

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                // The grid itself — always in the hierarchy so SwiftUI doesn't
                // tear it down when assets briefly go empty during a source
                // switch. We fade it under the empty-state only when nothing is
                // loaded at all.
                ScrollViewReader { proxy in
                    ScrollView {
                        Group {
                            if vm.isMerged {
                                mergedGrid
                            } else {
                                normalGrid
                            }
                        }
                        // UITest sentinel — the harness uses
                        // `app.otherElements["browse-grid"]` to confirm browse
                        // mode is active before driving thumbnail selection.
                        .accessibilityIdentifier("browse-grid")
                        .padding(8)
                        // Bottom padding so the last row isn't hidden under
                        // the selection bar when it's shown.
                        .padding(.bottom, vm.isSelecting ? 60 : 0)
                    }
                    .background(MapleTokens.bg)
                    .opacity(isEmpty ? 0 : 1)
                    .onChange(of: vm.selectedID) { _, newID in
                        // Minimum scroll — bring the cell into view only when it's
                        // outside the viewport. `.center` re-centered every click,
                        // and the resulting mid-click layout shift made rapid taps
                        // land on the wrong cell. Keyboard arrow nav still works:
                        // when the next/prev cell is offscreen, SwiftUI scrolls just
                        // enough to expose it.
                        if let id = newID { proxy.scrollTo(id, anchor: nil) }
                    }
                }

                // Error banner at the top of the grid.
                if let err = vm.loadError {
                    ErrorBanner(
                        message: err.localizedDescription,
                        onRetry: { vm.loadError = nil },
                        onDismiss: { vm.loadError = nil }
                    )
                    .padding(8)
                }

                // Empty state overlay — only when the folder has zero folders AND
                // zero images.
                if isEmpty {
                    BrowseEmptyState(vm: vm, onGrantPhotosAccess: onGrantPhotosAccess)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(MapleTokens.bg)
                }
            }

            // Multi-select action bar — shown only when in select mode and an
            // onMergePanorama handler was wired (prevents showing in previews).
            if vm.isSelecting, let onMergePanorama {
                PanoSelectionBar(
                    vm: vm,
                    onMerge: onMergePanorama,
                    onEditMetadata: onEditMetadata,
                    onBatchRename: onBatchRename,
                    onPasteAdjustments: clipboard != nil ? { pasteAdjustments(groups: Set(AdjustmentGroup.allCases)) } : nil,
                    onPasteSelectedGroups: clipboard != nil ? { showAdjustmentGroupPicker = true } : nil,
                    onSyncSettings: clipboard != nil ? { syncSettings() } : nil,
                    canPaste: (clipboard?.hasContents ?? false) && !vm.selectedIDs.isEmpty,
                    canSync: canSyncSettings
                )
            }
        }
        .sheet(isPresented: $showAdjustmentGroupPicker) {
            if let source = clipboard?.contents {
                AdjustmentGroupPickerSheet(
                    sourceName: source.sourceName,
                    targetCount: vm.selectedIDs.count,
                    onApply: { groups in
                        pasteAdjustments(groups: groups)
                        showAdjustmentGroupPicker = false
                    },
                    onCancel: { showAdjustmentGroupPicker = false }
                )
            }
        }
        // macOS maps the hardware Delete key to trash via `onDeleteCommand`;
        // iOS doesn't ship that modifier (the iOS/iPad trash path is the
        // multi-select action bar and the per-tile context menu).
        #if os(macOS)
        .onDeleteCommand {
            guard let onTrashAssets else { return }
            onTrashAssets(activeSelectionIDs())
        }
        #endif
        .keyboardShortcuts(
            vm: vm,
            sessions: sessions,
            // #944: ⌘C/⌘V are only claimed when a clipboard is wired
            // (production always wires one; previews don't).
            onCopyAdjustments: clipboard != nil ? { copyAdjustments() } : nil,
            onPasteAdjustments: clipboard != nil
                ? { pasteAdjustments(groups: Set(AdjustmentGroup.allCases)) } : nil
        )
        .task {
            // Build the merged-mode cloud provider ONCE (not per body eval). The
            // host must be set when cloud infra is wired, else CloudThumbCache
            // lookups collide across servers under an empty namespace.
            guard mergedProvider == nil, let client = thumbClient, let cache = thumbCache
            else { return }
            assert(!mergedHost.isEmpty, "BrowseGrid: cloud thumb infra wired without a mergedHost")
            mergedProvider = ThumbnailProvider(thumbClient: client, thumbCache: cache)
        }
    }

    // MARK: - Merged grid (PhotoKit + Cloud timeline)

    /// Renders when `vm.isMerged` is true. No folders, no multi-select.
    /// Each `MergedTimelineCell` maps to a `PhotoGridItem(merged:)` inside
    /// the `LazyVGrid`'s `ForEach` (lazy — only visible cells pay the cost).
    @ViewBuilder
    private var mergedGrid: some View {
        PhotoGrid(
            data: vm.mergedCells,
            columns: .responsiveBySizeClass,
            provider: mergedProvider ?? localProvider,
            displayMode: resolvedDisplayMode,
            // Tap routing: the original BrowseGrid merged-mode ForEach had no
            // .onTapGesture — merged cells in BrowseGrid are informational only;
            // the full merged-tap routing lives in CloudTimelineView. Kept as
            // no-op to preserve the same behaviour.
            onTap: { _ in },
            makeItem: { cell in
                PhotoGridItem(
                    merged: cell,
                    host: mergedHost,
                    sync: syncBadge(for: cell),
                    style: .desktop
                )
            }
        )
    }

    // MARK: - Normal grid (local assets + subfolders)

    /// Renders when `vm.isMerged` is false. Includes folder cells in the
    /// `leading:` slot, desktop badge overlays, multi-select, and session priming.
    @ViewBuilder
    private var normalGrid: some View {
        PhotoGrid(
            data: vm.assets,
            columns: .responsiveBySizeClass,
            provider: localProvider,
            displayMode: resolvedDisplayMode,
            selection: vm.isSelecting
                ? vm.selectedIDs
                : (vm.selectedID.map { Set([$0]) } ?? []),
            onAppearItem: { asset in onPrimeSession?(asset) },
            multiSelectChecked: vm.isSelecting ? { asset in
                vm.selectedIDs.contains(asset.id)
            } : nil,
            // Drag-onto-source-tree (#2646). PhotoKit is neither a drag
            // source nor a drop target (design doc) — no user-writable
            // path to relocate. Every other current-grid asset (local,
            // SMB, Cloud) is draggable; if the dragged tile is part of a
            // larger active selection, the WHOLE selection rides along
            // ("multi-select drag carries the whole selection if the
            // dragged item is part of it").
            //
            // Performance (review finding, jules): this closure runs once
            // per VISIBLE cell on every render — a `vm.assets.filter` here
            // was an O(library size) scan per cell, so scrolling a 50k-
            // asset library re-ran millions of comparisons a frame. Build
            // the payload straight from the (already O(1)-membership) `Set`
            // of selected ids instead — O(selection size), not O(library
            // size). Payload order is therefore selection-insertion order,
            // not grid order; `AppShell+AssetDrop.swift`'s
            // `performAssetDrop` restores grid order once, at drop time,
            // from the already-materialized `browseVM.assets` array — not
            // per cell here.
            dragPayload: { asset in
                guard asset.thumbnailProvenance != .photoKit, !(vm.currentSource is PhotoKitSource) else {
                    return nil
                }
                let active = vm.isSelecting ? vm.selectedIDs : (vm.selectedID.map { Set([$0]) } ?? [])
                guard active.contains(asset.id), active.count > 1 else {
                    return DraggedAssetPayload(ids: [asset.id])
                }
                return DraggedAssetPayload(ids: Array(active))
            },
            contextMenuItems: { (asset: AssetRef) in
                // Reveal in Finder (#2658) rides in the same per-cell menu
                // as Move to Trash rather than a second closure threaded
                // through every Mac/iPad/iPhone shell — it needs no
                // external wiring (NSWorkspace is a direct OS call), it's
                // macOS-only (no Finder on iOS/iPadOS), and it self-gates
                // on `revealEligible` so the item is HIDDEN — not shown
                // disabled — for PhotoKit/Cloud/SMB assets that have no
                // on-disk `primaryURL`.
                #if os(macOS)
                let showReveal = revealEligible(asset)
                #else
                let showReveal = false
                #endif
                guard onTrashAssets != nil || showReveal || assetRename != nil else { return nil }
                return AnyView(
                    Group {
                        if let assetRename {
                            renameMenuItem(for: asset, renameCtx: assetRename)
                        }
                        if let onTrashAssets {
                            trashMenuItem(for: asset, onTrashAssets: onTrashAssets)
                        }
                        #if os(macOS)
                        if showReveal {
                            revealMenuItem(for: asset)
                        }
                        #endif
                    }
                )
            },
            renameOverlay: { asset in AnyView(GridCellRenameCaption(asset: asset)) },
            onTap: { asset in
                if vm.isSelecting {
                    // Multi-select mode: tap toggles check.
                    vm.toggleSelected(asset.id)
                } else {
                    // Normal mode: tap opens the editor.
                    vm.selectedID = asset.id
                    onOpenEditor?(asset)
                }
            },
            makeItem: { asset in
                PhotoGridItem(local: asset, source: vm.currentSource,
                              overlays: desktopOverlays(for: asset))
            },
            leading: {
                // Sub-folders first — Finder-style — then images.
                // Folder cells are hidden during multi-select so
                // only image tiles can be checked.
                if !vm.isSelecting {
                    ForEach(vm.subfolders, id: \.self) { url in
                        // Single tap navigates into the folder. The
                        // FolderCell button style provides press
                        // feedback (scale + tinted background) so the
                        // user gets immediate confirmation the tap
                        // registered before the grid reloads.
                        FolderCell(
                            url: url,
                            rootBookmark: currentRootBookmark,
                            onDropAssets: onDropAssetsOnFolder,
                            onNavigate: { onNavigateFolder?(url) }
                        )
                    }
                }
            }
        )
        // ScrollViewReader uses the element's `.id` as the scrollTo anchor.
        // ForEach inside PhotoGrid tags each element by `element.id` (AssetRef.ID),
        // which is the same value `vm.selectedID` holds — so scrollTo works.
    }

    // MARK: - Overlay derivation

    /// Desktop badge overlays for one asset, derived from `sessions[asset.id]`.
    /// Matches the original LibraryCell `.desktop` badge derivation exactly.
    private func desktopOverlays(for asset: AssetRef) -> GridCellOverlays {
        let session = sessions[asset.id]
        let cullFlag = session?.culling.flag ?? .none
        return GridCellOverlays(
            rating: session?.culling.stars ?? 0,
            flag: cullFlag == .none ? nil : cullFlag,
            sync: nil,
            isVideo: false,
            style: .desktop,
            hidden: session?.culling.hidden ?? false
        )
    }

    // MARK: - Merged cell SyncBadge derivation

    private func syncBadge(for cell: MergedTimelineCell) -> SyncBadge {
        switch cell {
        case .synced:    return .synced
        case .cloudOnly: return .cloudOnly
        case .localOnly: return .localOnly
        }
    }

    // MARK: - Trash (#2653)

    /// The grid's current selection — multi-select checked set, or just
    /// the focused single asset. Same shape as the drag-payload "active
    /// selection" computation above.
    private func activeSelectionIDs() -> [AssetRef.ID] {
        vm.isSelecting ? Array(vm.selectedIDs) : (vm.selectedID.map { [$0] } ?? [])
    }

    /// "Move to Trash" context-menu item for one cell. If the right-clicked
    /// asset is part of a larger active multi-selection, the whole
    /// selection trashes together (matching the drag-payload's "multi-select
    /// carries the whole selection" rule); otherwise just this one asset.
    /// Label wording surfaces the design doc's platform asymmetry (macOS
    /// Filesystem → the real OS Trash) directly at the point of action,
    /// rather than only after the fact in the result sheet.
    @ViewBuilder
    private func trashMenuItem(for asset: AssetRef, onTrashAssets: @escaping ([AssetRef.ID]) -> Void) -> some View {
        if vm.currentSource is PhotoKitSource || asset.thumbnailProvenance == .photoKit {
            Text("Photos Library items can't be trashed from Maple")
        } else {
            Button(role: .destructive) {
                let active = activeSelectionIDs()
                let ids = active.contains(asset.id) && active.count > 1 ? active : [asset.id]
                onTrashAssets(ids)
            } label: {
                Label(trashMenuTitle(for: asset), systemImage: "trash")
            }
            .accessibilityIdentifier("browseGrid.trash.\(asset.displayName)")
        }
    }

    private func trashMenuTitle(for asset: AssetRef) -> String {
        #if os(macOS)
        let isLocalFilesystem = asset.primaryURL != nil && asset.catalog == nil && !(vm.currentSource is SMBSource)
        return isLocalFilesystem ? "Move to Trash (Finder)" : "Move to Trash"
        #else
        return "Move to Trash"
        #endif
    }

    // MARK: - Reveal in Finder (#2658)

    #if os(macOS)
    /// True only for a local-filesystem asset — the only case with a real
    /// on-disk `primaryURL` Finder can point at. Delegates to
    /// `AssetRef.isRevealEligible` (RevealInFileManagerSelection.swift,
    /// MapleCore) rather than re-deriving the check inline, so the same
    /// rule PhotoKit/Cloud/SMB assets fall out of is covered by
    /// `RevealInFileManagerSelectionTests` and can't drift between the
    /// view and its test.
    private func revealEligible(_ asset: AssetRef) -> Bool {
        asset.isRevealEligible
    }

    /// "Reveal in Finder" context-menu item. Mirrors `trashMenuItem`'s
    /// multi-select rule: if the right-clicked asset is part of a larger
    /// active selection, every eligible selected asset reveals together
    /// via `activateFileViewerSelecting`'s array form — one Finder window,
    /// every item highlighted — otherwise just this one. The actual
    /// selection → URLs derivation is `RevealInFileManagerSelection.urls`
    /// (MapleCore, unit-tested) rather than an inline filter here — it
    /// already converts the id list to a `Set` before filtering
    /// `vm.assets`, so a select-all-then-Reveal on a large library stays
    /// O(librarySize) instead of O(librarySize × selectionSize).
    @ViewBuilder
    private func revealMenuItem(for asset: AssetRef) -> some View {
        Button {
            let active = activeSelectionIDs()
            let ids = active.contains(asset.id) && active.count > 1 ? active : [asset.id]
            let urls = RevealInFileManagerSelection.urls(for: Set(ids), in: vm.assets)
            guard !urls.isEmpty else { return }
            NSWorkspace.shared.activateFileViewerSelecting(urls)
        } label: {
            Label("Reveal in Finder", systemImage: "folder")
        }
        .accessibilityIdentifier("browseGrid.revealInFinder.\(asset.displayName)")
    }
    #endif

    // MARK: - Copy / paste / sync adjustments (#944)

    /// True once a focused image (`vm.selectedID`) AND at least one OTHER
    /// checked asset are both present — "sync" needs a source plus at
    /// least one distinct target.
    private var canSyncSettings: Bool {
        guard let sourceID = vm.selectedID else { return false }
        return vm.selectedIDs.contains { $0 != sourceID }
    }

    /// Captures the focused image's current `AdjustmentModel` into
    /// `clipboard`. Wired to ⌘C (`BrowseKeyboardShortcuts`).
    ///
    /// Resolves through `AdjustmentPasteApplier.resolveModel` rather than
    /// reading `sessions[asset.id]` directly: Browse primes an `EditSession`
    /// lazily, so a focused image the user has not opened this launch has no
    /// live session and its real edit lives only in its sidecar. Reading the
    /// session dict alone would silently copy a default (unedited) model.
    private func copyAdjustments() {
        guard let clipboard, let asset = vm.selectedAsset else { return }
        let liveSessions = sessions
        Task { @MainActor in
            let model = await AdjustmentPasteApplier.resolveModel(
                for: asset, sessions: liveSessions
            )
            clipboard.copy(model: model, sourceName: asset.displayName)
        }
    }

    /// Writes `groups` from the clipboard onto every checked asset
    /// (`vm.selectedIDs`). Wired to ⌘V, the selection bar's "Paste
    /// Adjustments" button (full groups), and the selective-paste sheet's
    /// Apply button (chosen groups).
    private func pasteAdjustments(groups: Set<AdjustmentGroup>) {
        guard let source = clipboard?.contents?.model else { return }
        let targets = vm.selectedAssets
        guard !targets.isEmpty else { return }
        let liveSessions = sessions
        Task { @MainActor in
            await AdjustmentPasteApplier.apply(
                source: source, groups: groups, to: targets, sessions: liveSessions
            )
        }
    }

    /// Applies the focused image's CURRENT edit (no prior copy needed)
    /// across the rest of the multi-selection. The focused asset itself is
    /// excluded from `targets` so it is never rewritten. Wired to the
    /// selection bar's "Sync Settings" button.
    private func syncSettings() {
        guard let sourceAsset = vm.selectedAsset else { return }
        let targets = vm.selectedAssets.filter { $0.id != sourceAsset.id }
        guard !targets.isEmpty else { return }
        let liveSessions = sessions
        Task { @MainActor in
            let sourceModel = await AdjustmentPasteApplier.resolveModel(
                for: sourceAsset, sessions: liveSessions
            )
            await AdjustmentPasteApplier.apply(
                source: sourceModel,
                groups: Set(AdjustmentGroup.allCases),
                to: targets,
                sessions: liveSessions
            )
        }
    }

}

// MARK: - FolderCell

/// Grid cell rendering a sub-folder. Single tap navigates into it; the
/// cell is wrapped in a Button with a custom ButtonStyle so the user
/// gets press feedback (scale + tinted overlay) before the grid reloads.
///
/// Drop target (#2779): mirrors `LibrarySidebar`'s `FolderTreeRow` — same
/// payload type, same `isTargeted`-driven highlight, same
/// `onDropAssets`/`rootBookmark` contract, routed by the caller into the
/// identical `AppShell.handleAssetDrop` entry point. Active only when both
/// `rootBookmark` and `onDropAssets` are non-nil (always true together in
/// production; previews leave both `nil` and get no drop target).
private struct FolderCell: View {
    let url: URL
    let rootBookmark: Data?
    let onDropAssets: ((URL, Data, Set<AssetRef.ID>?, Bool) -> Void)?
    let onNavigate: () -> Void

    @State private var isDropTargeted = false

    var body: some View {
        Button(action: onNavigate) {
            VStack(spacing: 4) {
                RoundedRectangle(cornerRadius: 4)
                    .fill(MapleTokens.surfaceAlt)
                    .aspectRatio(3/2, contentMode: .fit)
                    .overlay {
                        Image(systemName: "folder.fill")
                            .font(.system(size: 36))
                            .foregroundStyle(MapleTokens.primary.opacity(0.85))
                    }
                    .overlay {
                        if isDropTargeted {
                            RoundedRectangle(cornerRadius: 4)
                                .fill(MapleTokens.primary.opacity(0.15))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 4)
                                        .strokeBorder(MapleTokens.primary, lineWidth: 2)
                                )
                        }
                    }
                Text(url.lastPathComponent)
                    .font(MapleTokens.Typography.body)
                    .foregroundStyle(MapleTokens.textMain)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(FolderCellButtonStyle())
        .accessibilityLabel("Folder \(url.lastPathComponent)")
        .dropDestination(for: DraggedAssetPayload.self, action: { payloads, _ in
            guard let rootBookmark, let onDropAssets,
                  let payload = payloads.first, !payload.ids.isEmpty else { return false }
            onDropAssets(url, rootBookmark, Set(payload.ids), MapleDragModifier.isCopyRequested())
            return true
        }, isTargeted: { targeted in isDropTargeted = targeted })
    }
}

/// Press feedback for FolderCell. Scales down slightly and overlays a
/// subtle white tint while the user's finger is down, easing back when
/// released — same idea as iOS list-row highlights, scoped to the cell.
private struct FolderCellButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1.0)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(configuration.isPressed ? MapleTokens.bgActive : .clear)
                    .padding(-4)
            )
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

// MARK: - ErrorBanner

/// Thin red banner that sits at the top of the grid when `vm.loadError`
/// is non-nil. Matches the shape of the web `app-error-banner`.
private struct ErrorBanner: View {
    let message: String
    let onRetry: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(MapleTokens.errorText)
            Text(message)
                .font(.system(size: 11))
                .foregroundStyle(MapleTokens.errorText)
                .lineLimit(2)
            Spacer()
            Button("Retry", action: onRetry)
                .font(.system(size: 11))
                .buttonStyle(.plain)
                .foregroundStyle(MapleTokens.primary)
            Button {
                onDismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(MapleTokens.textMuted)
            }
            .buttonStyle(.plain)
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(MapleTokens.errorBg)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(MapleTokens.errorText.opacity(0.4), lineWidth: 0.5)
                )
        )
    }
}

// MARK: - Keyboard shortcuts via ViewModifier

private struct BrowseKeyboardShortcuts: ViewModifier {
    let vm: BrowseViewModel
    let sessions: [AssetRef.ID: EditSession]
    /// #944: ⌘C copies the focused image's adjustments; ⌘V pastes the
    /// clipboard's adjustments onto every checked asset. `nil` leaves the
    /// shortcut unclaimed (no clipboard wired — e.g. previews).
    var onCopyAdjustments: (() -> Void)? = nil
    var onPasteAdjustments: (() -> Void)? = nil

    /// #2638 — Enter on a selected (non-editing, non-multi-select) asset
    /// begins inline rename. Reads the environment action directly rather
    /// than threading a callback param through `BrowseGrid`'s init — the
    /// grid has no other reason to know about rename.
    @Environment(\.assetRename) private var assetRename

    func body(content: Content) -> some View {
        content
            // Arrow navigation
            .onKeyPress(.rightArrow) { vm.selectNext(); return .handled }
            .onKeyPress(.leftArrow)  { vm.selectPrev(); return .handled }
            // #2638: inline rename entry point. Single-select only — Enter
            // during multi-select has no one obvious target and multi-asset
            // rename isn't this ticket's scope (batch rename is #2639).
            // `.ignored` when there's nothing to act on so this doesn't
            // swallow Enter for some other in-focus control.
            .onKeyPress(.return) {
                guard !vm.isSelecting, let asset = vm.selectedAsset, let assetRename else { return .ignored }
                assetRename.begin(asset)
                return .handled
            }
            // Star ratings 1-5
            .onKeyPress("1") { setStars(1); return .handled }
            .onKeyPress("2") { setStars(2); return .handled }
            .onKeyPress("3") { setStars(3); return .handled }
            .onKeyPress("4") { setStars(4); return .handled }
            .onKeyPress("5") { setStars(5); return .handled }
            .onKeyPress("0") { setStars(0); return .handled }
            // Pick / reject
            .onKeyPress("p") { setFlag(.pick);   return .handled }
            .onKeyPress("x") { setFlag(.reject); return .handled }
            .onKeyPress("u") { setFlag(.none);   return .handled }
            // #944: copy/paste adjustments — Command-modified, so these use
            // the `KeyPress`-carrying overload to inspect `.modifiers`
            // rather than the bare-key overload the shortcuts above use.
            .onKeyPress("c", phases: .down) { press in
                guard press.modifiers.contains(.command), let onCopyAdjustments else { return .ignored }
                onCopyAdjustments()
                return .handled
            }
            .onKeyPress("v", phases: .down) { press in
                guard press.modifiers.contains(.command), let onPasteAdjustments else { return .ignored }
                onPasteAdjustments()
                return .handled
            }
    }

    private func setStars(_ n: Int) {
        guard let id = vm.selectedID, let session = sessions[id] else { return }
        Task { @MainActor in
            var c = session.culling
            c.stars = n
            session.culling = c
        }
    }

    private func setFlag(_ f: CullFlag) {
        guard let id = vm.selectedID, let session = sessions[id] else { return }
        Task { @MainActor in
            var c = session.culling
            c.flag = f
            session.culling = c
        }
    }
}

private extension View {
    func keyboardShortcuts(
        vm: BrowseViewModel,
        sessions: [AssetRef.ID: EditSession],
        onCopyAdjustments: (() -> Void)? = nil,
        onPasteAdjustments: (() -> Void)? = nil
    ) -> some View {
        modifier(BrowseKeyboardShortcuts(
            vm: vm,
            sessions: sessions,
            onCopyAdjustments: onCopyAdjustments,
            onPasteAdjustments: onPasteAdjustments
        ))
    }
}

// MARK: - Previews
//
// Issue #139 — grid against the `BrowseViewModel.preview(...)` factory.
// Thumbnails fail to load (the preview AssetRef has no bytes), so each
// cell shows the placeholder shimmer; the grid layout itself renders
// correctly. Coverage: empty, loaded, loading, error, photosAuthNeeded.

private struct _BrowseGridPreviewWrapper: View {
    let vm: BrowseViewModel
    let grantPhotos: Bool
    @State private var sessions: [AssetRef.ID: EditSession] = [:]

    init(vm: BrowseViewModel, grantPhotos: Bool = false) {
        self.vm = vm
        self.grantPhotos = grantPhotos
    }

    var body: some View {
        BrowseGrid(
            vm: vm,
            sessions: $sessions,
            onGrantPhotosAccess: grantPhotos ? {} : nil
        )
        .frame(width: 720, height: 540)
    }
}

#Preview("Loaded") {
    _BrowseGridPreviewWrapper(vm: BrowseViewModel.preview(.loaded(count: 18)))
}

#Preview("Empty") {
    _BrowseGridPreviewWrapper(vm: BrowseViewModel.preview(.empty))
}

#Preview("Loading") {
    _BrowseGridPreviewWrapper(vm: BrowseViewModel.preview(.loading))
}

#Preview("Error") {
    _BrowseGridPreviewWrapper(vm: BrowseViewModel.preview(.error))
}

#Preview("Photos access needed") {
    _BrowseGridPreviewWrapper(vm: BrowseViewModel.preview(.photosAuthNeeded),
                              grantPhotos: true)
}
