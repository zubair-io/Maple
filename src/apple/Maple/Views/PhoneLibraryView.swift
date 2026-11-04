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

  struct PhoneLibraryView<ToolbarContentT: ToolbarContent>: View {
    @Binding var isDrawerOpen: Bool
    let mode: AppShell.Mode
    let selectedSession: EditSession?
    let libraryTitle: String

    let cloudTimelineVM: CloudTimelineViewModel?
    let cloudTimelineThumbClient: CloudThumbClient?
    let cloudTimelineThumbCache: CloudThumbCache?
    let allSourcesTimelineVM: AllSourcesTimelineViewModel?
    let allSourcesTimelineThumbCache: CloudThumbCache?
    /// Non-nil while the sidebar's MAP row (#2830, `.map` selection) is
    /// current (#2886) — forwarded straight through to `AppShellIPhoneShell`
    /// → `AppShellCenterColumn`, same three values `AppShellMacLayout` gets
    /// from the Mac/iPad sidebar's MAP row.
    let mapVM: MapViewModel?
    let mapThumbClient: CloudThumbClient?
    let mapThumbCache: CloudThumbCache?
    /// Why `.map` has no `mapVM` yet (#2848) — forwarded straight through
    /// to `AppShellCenterColumn`'s `MapEmptyState`.
    let mapUnavailableReason: MapUnavailableReason?
    @Binding var browseDisplayMode: GridDisplayMode
    /// The root screen's model. Pushed folder levels carry their own.
    let browseVM: BrowseViewModel
    /// The top level's model: the folder the open photo came from.
    let activeBrowseVM: BrowseViewModel
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
    /// Map pin/cluster tap (#2830) → AppShell activates search filtered by
    /// the resolved target (a place name, or the has-GPS scope fallback).
    let onSelectMapPlace: (MapPlaceSearchTarget) -> Void
    let onSignInForMap: (URL) -> Void
    let onSelectLocalAsset: (ImageRef) -> Void
    let onGrantPhotosAccess: () -> Void
    let onNavigateFolder: (URL) -> Void
    let onOpenEditor: (AssetRef) -> Void
    /// A Library tile tap with the tile's window-space frame (Preview hero).
    var onOpenTile: (AssetRef, CGRect) -> Void = { _, _ in }
    /// Live window-space frame of the selected tile (Preview hero close).
    var onSelectedTileFrameChange: ((CGRect) -> Void)? = nil
    /// The photo whose tile is blanked while the Preview hero carries it.
    var hiddenTileID: AssetRef.ID? = nil
    let onPrimeSession: (AssetRef) async -> Void
    let onReadGridFilterMetadata: @MainActor @Sendable (AssetRef) async throws -> GridFilterMetadata
    let makeEditSession: (AssetRef) -> EditSession
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
    /// #2641: opens the batch rename sheet when the user taps "Batch Rename…".
    var onBatchRename: (() -> Void)? = nil
    /// #2653: Delete key / "Move to Trash" context-menu item, forwarded
    /// through to BrowseGrid via AppShellIPhoneShell.
    var onTrashAssets: (([AssetRef.ID]) -> Void)? = nil
    var onExport: (([AssetRef]) -> Void)? = nil
    var onMove: (([AssetRef.ID]) -> Void)? = nil
    /// #944: app-level copy/paste/sync-adjustments clipboard, forwarded
    /// through to BrowseGrid via AppShellIPhoneShell.
    var clipboard: AdjustmentClipboard? = nil

    var body: some View {
      libraryScreen(folder: nil)
        // Fast Preview epic §1: a grid / cloud-result tap puts `.preview`
        // in `libraryPath` and Preview's Edit pushes `.edit` on top. Only
        // `.edit` and folder levels reach the stack
        // (`PhoneTabShell.pushedLibraryPath`); `.preview` is drawn by the
        // hero overlay, with the grid live beneath it. The tab bar hides
        // for the editor (#625/#791) and stays for folders.
        .navigationDestination(for: LibraryDestination.self) { destination in
          switch destination {
          case .folder(let level):
            libraryScreen(folder: level)
          case .preview:
            // Never pushed — see `PhoneTabShell.pushedLibraryPath`.
            EmptyView()
          case .edit(let ref):
            editor(for: ref)
              .toolbar(.hidden, for: .tabBar)
          }
        }
    }

    /// The root screen, or one pushed folder level. Only the root offers the
    /// side-menu button and the Timeline / Map surfaces; a folder level gets
    /// the system back button named after its parent.
    private func libraryScreen(folder: FolderLevel?) -> some View {
      let screenVM = folder?.browseVM ?? browseVM
      // Only the top screen drives the Preview hero's tile frames.
      let isTop = screenVM === activeBrowseVM
      return AppShellIPhoneShell(
        isDrawerOpen: $isDrawerOpen,
        mode: mode,
        selectedSession: selectedSession,
        libraryTitle: folder?.title ?? libraryTitle,
        cloudTimelineVM: folder == nil ? cloudTimelineVM : nil,
        cloudTimelineThumbClient: cloudTimelineThumbClient,
        cloudTimelineThumbCache: cloudTimelineThumbCache,
        allSourcesTimelineVM: folder == nil ? allSourcesTimelineVM : nil,
        allSourcesTimelineThumbCache: allSourcesTimelineThumbCache,
        mapVM: folder == nil ? mapVM : nil,
        mapThumbClient: mapThumbClient,
        mapThumbCache: mapThumbCache,
        mapUnavailableReason: folder == nil ? mapUnavailableReason : nil,
        browseDisplayMode: $browseDisplayMode,
        browseVM: screenVM,
        sessions: $sessions,
        toolbarContent: toolbarContent,
        showsBrowseToolbar: !LibraryDestination.presentsPreviewHero(in: libraryPath),
        showsDrawerButton: folder == nil,
        onSelectCloudAsset: onSelectCloudAsset,
        onSelectMapPlace: onSelectMapPlace,
        onSignInForMap: onSignInForMap,
        onSelectLocalAsset: onSelectLocalAsset,
        onGrantPhotosAccess: onGrantPhotosAccess,
        onNavigateFolder: onNavigateFolder,
        onOpenEditor: onOpenEditor,
        onOpenTile: onOpenTile,
        onPrimeSession: onPrimeSession,
        onReadGridFilterMetadata: onReadGridFilterMetadata,
        onFullImageFallback: onFullImageFallback,
        onSelectedTileFrameChange: isTop ? onSelectedTileFrameChange : nil,
        hiddenTileID: isTop ? hiddenTileID : nil,
        onMergePanorama: onMergePanorama,
        onEditMetadata: onEditMetadata,
        onBatchRename: onBatchRename,
        onTrashAssets: onTrashAssets,
        onExport: onExport,
        onMove: onMove,
        clipboard: clipboard
      )
    }

    private func editor(for ref: AssetRef) -> some View {
      EditorDestination(
        asset: ref,
        filmstripAssets: activeBrowseVM.assets.contains(ref)
          ? activeBrowseVM.assets : timelinePreviewSiblingAssets(ref),
        filmstripSource: activeBrowseVM.currentSource ?? cloudPreviewSource,
        onSelectAsset: { sibling in
          guard sibling.id != ref.id else { return }
          activeBrowseVM.selectedID = sibling.id
          Task { await onPrimeSession(sibling) }
          libraryPath = LibraryDestination.replacingAsset(in: libraryPath, with: sibling)
        },
        makeEditSession: makeEditSession,
        sessions: $sessions
      )
      .id(ref.id)
    }
  }

#endif
