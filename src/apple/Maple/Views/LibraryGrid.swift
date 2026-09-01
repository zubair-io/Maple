// LibraryGrid.swift — responsive-program S2 (#623). Responsive photo
// grid for the Library tab.
//
// Spec: docs/design/responsive-program/s2-library-grid.md.

#if os(iOS)

import SwiftUI
import MapleCore
#if canImport(UIKit)
import UIKit
#endif

struct LibraryGrid: View {

    let vm: BrowseViewModel
    let source: (any ImageSource)?
    @Binding var sessions: [AssetRef.ID: EditSession]
    @Binding var displayMode: GridDisplayMode
    let transitionNamespace: Namespace.ID?

    let onOpenEditor: (AssetRef) -> Void
    let onPrimeSession: (AssetRef) -> Void
    /// Tap on a sub-folder tile — drills the grid into that folder.
    let onNavigateFolder: (URL) -> Void
    /// Fired by the empty state's "Connect" button when `vm.photosAuthNeeded`
    /// is true. Same closure `BrowseGrid` gets on Mac / iPad — without it the
    /// panel renders disabled and the phone has no route to the system
    /// permission prompt at all (#2924). `nil` in previews.
    var onGrantPhotosAccess: (() -> Void)? = nil

    /// Local-only thumbnail provider.
    @State private var provider = ThumbnailProvider.local()

    /// Mirrors `BrowseGrid.isEmpty` — the empty state takes over only when
    /// the source yields neither images nor sub-folders.
    private var isEmpty: Bool {
        vm.assets.isEmpty && vm.subfolders.isEmpty
    }

    var body: some View {
        Group {
            // Zero images and zero sub-folders — hand the surface to the
            // shared overlay, which explains WHY it's empty (permission
            // panel / spinner / load error / no source picked). Before
            // #2924 this branch didn't exist and the phone rendered an
            // empty ScrollView, i.e. nothing.
            if isEmpty {
                BrowseEmptyState(vm: vm, onGrantPhotosAccess: onGrantPhotosAccess)
            } else {
                grid
            }
        }
        .accessibilityIdentifier("library-grid")
        // Maple surface behind the grid (incl. behind the translucent bars) so the
        // Library matches BrowseGrid / CloudSearchView — Copilot review on #1646.
        .background(MapleTokens.bg.ignoresSafeArea())
    }

    private var grid: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // Sub-folders first (Finder-style) in their own tile section
                // above the images (#3099) — the same `FolderTile` the desktop
                // BrowseGrid renders. Order stays reversed per #782 so the
                // first-level folders read newest/last-first on the phone.
                if !vm.subfolders.isEmpty {
                    FolderTileSection {
                        ForEach(Array(vm.subfolders.reversed()), id: \.self) { url in
                            FolderTile(url: url) { onNavigateFolder(url) }
                        }
                    }
                }
                PhotoGrid(
                    data: vm.assets,
                    columns: .responsiveBySizeClass,
                    provider: provider,
                    displayMode: displayMode,
                    selection: vm.selectedID.map { Set([$0]) } ?? [],
                    transitionNamespace: transitionNamespace,
                    onAppearItem: { asset in
                        onPrimeSession(asset)
                        Task { await vm.loadMorePhotoKitIfNeeded(appearing: asset.id) }
                    },
                    onTap: { asset in
                        vm.selectedID = asset.id
                        #if canImport(UIKit)
                        UISelectionFeedbackGenerator().selectionChanged()
                        #endif
                        onOpenEditor(asset)
                    },
                    makeItem: { asset in
                        PhotoGridItem(local: asset, source: source, overlays: overlays(for: asset))
                    }
                )
            }
            .padding(2)
        }
    }

    // MARK: - Overlay derivation

    private func overlays(for asset: AssetRef) -> GridCellOverlays {
        let session = sessions[asset.id]
        let cullFlag = session?.culling.flag ?? .none
        return GridCellOverlays(
            rating: session?.culling.stars ?? 0,
            flag: cullFlag == .none ? nil : cullFlag,
            sync: nil,
            isVideo: false,
            style: .phone,
            hidden: session?.culling.hidden ?? false
        )
    }
}

#endif
