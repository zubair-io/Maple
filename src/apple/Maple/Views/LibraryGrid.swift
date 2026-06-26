// LibraryGrid.swift — responsive-program S2 (#623). Responsive photo
// grid for the Library tab.
//
// M2 (#1570): replaced PhotoGrid with ScaleZoomGrid. The scale-zoom
// interaction is now the real grid on the iPhone Library surface.
// Zoom level persists via @AppStorage("grid.zoomLevel") threaded from
// AppShell as `zoomLevel: Binding<GridZoomLevel>`. Folders are packed
// as leading cells (slots 0..<vm.subfolders.count) so they zoom and
// scroll with the photos. The temporary ScaleZoomTest scaffold + focal-
// anchoring wiring from #1550 are removed.
//
// Cell tap routes through `onOpenEditor` (same callback BrowseGrid
// uses — the iPhone shell already pushes the Editor via
// `.navigationDestination(for: AssetRef.self)`).
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
    /// Persisted zoom level — backed by @AppStorage in AppShell (#1570 M2).
    @Binding var zoomLevel: GridZoomLevel

    let onOpenEditor: (AssetRef) -> Void
    let onPrimeSession: (AssetRef) -> Void
    /// Tap on a sub-folder tile — drills the grid into that folder.
    let onNavigateFolder: (URL) -> Void

    /// Local-only thumbnail provider.
    @State private var provider = ThumbnailProvider.local()

    var body: some View {
        ScaleZoomGrid(
            data: vm.assets,
            level: $zoomLevel,
            provider: provider,
            makeItem: { asset in
                PhotoGridItem(local: asset, source: source, overlays: overlays(for: asset))
            },
            onTap: { asset in
                vm.selectedID = asset.id
                #if canImport(UIKit)
                UISelectionFeedbackGenerator().selectionChanged()
                #endif
                onOpenEditor(asset)
            },
            displayMode: displayMode,
            leadingCount: vm.subfolders.count,
            leading: { i in
                let reversed = Array(vm.subfolders.reversed())
                guard i < reversed.count else { return nil }
                let url = reversed[i]
                return AnyView(
                    LibraryFolderCell(url: url) { onNavigateFolder(url) }
                )
            },
            selection: vm.selectedID.map { Set([$0]) } ?? []
        )
        .accessibilityIdentifier("library-grid")
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
            style: .phone
        )
    }
}

// MARK: - LibraryFolderCell

/// Square sub-folder tile for the phone Library grid.
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
