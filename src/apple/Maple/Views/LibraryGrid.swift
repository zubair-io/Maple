// LibraryGrid.swift — responsive-program S2 (#623). Responsive photo
// grid for the Library tab.
//
// Drives column count, gap, and outer padding off the
// `@Environment(\.mapleLayout)` density signal published by AppShell.
// ColumnStrategy.zoom resolves per layout:
//   * phone   — exact fixed counts (1/3/5/10) per GridZoomLevel
//   * tablet  — adaptive at desktopCellWidth, reflows columns on resize
//   * desktop — adaptive at desktopCellWidth, reflows columns on resize
//
// Cell tap routes through `onOpenEditor` (same callback BrowseGrid
// uses — the iPhone shell already pushes the Editor via
// `.navigationDestination(for: AssetRef.self)`).
//
// The in-content source title and the cull filter-chip row were removed
// (#782): the source name lives in the nav bar, and the chips duplicated
// cull state that belongs in the editor. The grid now renders
// `vm.assets` unfiltered.
//
// Spec: docs/design/responsive-program/s2-library-grid.md.
//
// M1a (#1490): migrated onto the shared PhotoGrid / PhotoThumbnailCell /
// ThumbnailProvider. The LazyVGrid body is replaced; LibraryFolderCell
// is kept for the `leading:` slot. LibraryCell was deleted in M1b (#1490)
// after BrowseGrid migrated off it.
//
// #1550: ColumnStrategy.zoom replaces .responsiveBySizeClass; pinch modifier added.

#if os(iOS)

import SwiftUI
import MapleCore
#if canImport(UIKit)
import UIKit
#endif

struct LibraryGrid: View {
    @Environment(\.mapleLayout) private var layout

    let vm: BrowseViewModel
    let source: (any ImageSource)?
    @Binding var sessions: [AssetRef.ID: EditSession]
    @Binding var displayMode: GridDisplayMode
    /// Current zoom level — drives ColumnStrategy.zoom (#1550).
    @Binding var zoomLevel: GridZoomLevel

    let onOpenEditor: (AssetRef) -> Void
    let onPrimeSession: (AssetRef) -> Void
    /// Tap on a sub-folder tile — drills the grid into that folder.
    /// Forwarded straight to `AppShell.navigateFolder`, which is already
    /// cloud-aware (drills via `/api/fs/dir`) and handles local folders
    /// via the active security-scope bookmark.
    let onNavigateFolder: (URL) -> Void

    /// Local-only thumbnail provider. No cloud infra needed here — all
    /// assets in LibraryGrid are local filesystem / PhotoKit refs; the
    /// ThumbnailLoader handles them through the `.local` backend.
    @State private var provider = ThumbnailProvider.local()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // The in-content source title and the cull filter-chip row
                // (All / Picks / 4+ stars / Edited) were removed (#782):
                // the source name already lives in the nav bar, and the
                // chips duplicated cull state that belongs in the editor.
                PhotoGrid(
                    data: vm.assets,
                    columns: .zoom(zoomLevel),
                    provider: provider,
                    displayMode: displayMode,
                    // Selection is keyed by AssetRef.ID, so `vm.selectedID` maps
                    // straight through — no string-id derivation needed.
                    selection: vm.selectedID.map { Set([$0]) } ?? [],
                    onAppearItem: { asset in onPrimeSession(asset) },
                    onTap: { asset in
                        vm.selectedID = asset.id
                        // Selection haptic — matches the spec §2 phone
                        // interaction model (`.selection` on iOS).
                        #if canImport(UIKit)
                        UISelectionFeedbackGenerator().selectionChanged()
                        #endif
                        // Pushes the S5 Editor onto the phone Library
                        // tab's NavigationStack (#791). `PhoneTabShell`
                        // injects an `onOpenEditor` that appends `asset`
                        // to its `libraryPath`; `PhoneLibraryView`'s
                        // `.navigationDestination(for: AssetRef.self)`
                        // then resolves it into `EditorDestination →
                        // EditorView` and `.toolbar(.hidden, for:
                        // .tabBar)` hides the tab bar on push (spec §2).
                        // The Mac/iPad pane shell injects a different
                        // `onOpenEditor` (AppShell's `.browse →
                        // .fullImage` mode flip) — this shared cell stays
                        // agnostic to which one it got.
                        onOpenEditor(asset)
                    },
                    // Lazy: PhotoGrid calls this only for realized (visible)
                    // cells, so overlays are derived live per visible asset
                    // (never an eager map over the whole library).
                    makeItem: { asset in
                        PhotoGridItem(local: asset, source: source, overlays: overlays(for: asset))
                    },
                    leading: {
                        // Sub-folders first (Finder-style), then images — matches
                        // the desktop BrowseGrid. `vm.subfolders` is populated by
                        // loadFolder / loadCloudDir; without this the iPhone grid
                        // dropped folders entirely (they loaded but were never
                        // drawn). Order is reversed per request (#782) so the
                        // first-level folders read newest/last-first.
                        ForEach(Array(vm.subfolders.reversed()), id: \.self) { url in
                            LibraryFolderCell(url: url) { onNavigateFolder(url) }
                        }
                    }
                )
                .padding(.horizontal, outerHorizontalPadding)
                .accessibilityIdentifier("library-grid")
            }
        }
        .gridZoomPinch(level: $zoomLevel)
        .background(MapleTokens.bg)
    }

    // MARK: - Overlay derivation

    /// Phone badge overlays for one asset, derived from `sessions[asset.id]`
    /// exactly as `LibraryCell.phoneBadgeOverlay` did. `PhotoGrid` calls this
    /// lazily per realized cell, so badges stay live (re-read on each body pass
    /// for visible cells) without an eager map over the whole library:
    ///
    ///   - `rating` = session?.culling.stars ?? 0
    ///   - `flag`   = .pick / .reject / nil (`.none` → nil = no badge)
    ///   - `style`  = .phone  (green pick dot top-left, ≥4★ gold bottom-left)
    private func overlays(for asset: AssetRef) -> GridCellOverlays {
        let session = sessions[asset.id]
        let cullFlag = session?.culling.flag ?? .none
        return GridCellOverlays(
            rating: session?.culling.stars ?? 0,
            flag: cullFlag == .none ? nil : cullFlag,
            sync: nil,
            isVideo: false,
            style: .phone
        )
    }

    // MARK: - Layout

    private var outerHorizontalPadding: CGFloat {
        switch layout {
        case .phone:   return 2
        case .tablet:  return 8
        case .desktop: return 12
        }
    }
}

// MARK: - LibraryFolderCell

/// Square sub-folder tile for the phone Library grid. Sized to match the
/// square image cells (`LibraryCell`) so folder + image rows stay aligned
/// in the edge-bleed grid. Tap drills into the folder. (BrowseGrid uses
/// its own 3:2 `FolderCell` for the desktop explorer; the phone grid is
/// square, so it gets this variant rather than reusing that one.)
private struct LibraryFolderCell: View {
    let url: URL
    let onNavigate: () -> Void

    var body: some View {
        Button(action: onNavigate) {
            RoundedRectangle(cornerRadius: 2)
                .fill(MapleTokens.surfaceAlt)
                .aspectRatio(1, contentMode: .fit)
                .overlay {
                    Image(systemName: "folder.fill")
                        .font(.system(size: 34))
                        .foregroundStyle(MapleTokens.primary.opacity(0.85))
                }
                .overlay(alignment: .bottomLeading) {
                    Text(url.lastPathComponent)
                        .font(MapleTokens.Typography.body)
                        .foregroundStyle(MapleTokens.textMain)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .padding(6)
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Folder \(url.lastPathComponent)")
    }
}

#endif
