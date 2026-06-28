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

    let onOpenEditor: (AssetRef) -> Void
    let onPrimeSession: (AssetRef) -> Void
    /// Tap on a sub-folder tile — drills the grid into that folder.
    let onNavigateFolder: (URL) -> Void

    /// Local-only thumbnail provider.
    @State private var provider = ThumbnailProvider.local()

    var body: some View {
        ScrollView {
            PhotoGrid(
                data: vm.assets,
                columns: .responsiveBySizeClass,
                provider: provider,
                displayMode: displayMode,
                selection: vm.selectedID.map { Set([$0]) } ?? [],
                onAppearItem: { asset in onPrimeSession(asset) },
                onTap: { asset in
                    vm.selectedID = asset.id
                    #if canImport(UIKit)
                    UISelectionFeedbackGenerator().selectionChanged()
                    #endif
                    onOpenEditor(asset)
                },
                makeItem: { asset in
                    PhotoGridItem(local: asset, source: source, overlays: overlays(for: asset))
                },
                leading: {
                    ForEach(Array(vm.subfolders.reversed()), id: \.self) { url in
                        LibraryFolderCell(url: url) { onNavigateFolder(url) }
                    }
                }
            )
            .padding(2)
        }
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
