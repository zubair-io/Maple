// GridCellRenameCaption.swift — Browse grid's direct-manipulation entry
// point for single-asset rename (#2842). The per-cell right-click/long-
// press context menu (`BrowseGrid+Rename.swift`) is the other entry point;
// this one is double-click (macOS) / double-tap (iOS/iPadOS) on a filename
// caption overlaid at the bottom of the cell — the design doc's "double-
// click the filename in the grid cell" — plus the actual host that makes
// `renamingAssetID` render something once Enter (`BrowseGrid`'s
// `BrowseKeyboardShortcuts`) or the context-menu item begins a rename:
// before this file, `\.assetRename`'s only renderer was the Info panel's
// `AssetFilenameRow`, which Browse mode never shows, so both of those entry
// points silently did nothing.
//
// Reuses `InlineRenameField` for the actual edit UI — no forked draft
// state, validation, extension-change warning, or error surfacing. Kept out
// of the shared `PhotoThumbnailCell` (used by merged timeline, CloudTimeline,
// and PhotoKit-only surfaces that have no rename concept) and instead
// plugged in through `PhotoGrid`'s `renameOverlay` hook, opt-in the same way
// `contextMenuItems`/`dragPayload` already are.

import MapleCore
import SwiftUI

struct GridCellRenameCaption: View {
    let asset: AssetRef

    @Environment(\.assetRename) private var renameCtx

    private var isEditing: Bool {
        guard let renameCtx else { return false }
        return renameCtx.isRenaming(asset)
    }

    var body: some View {
        Group {
            if isEditing {
                InlineRenameField(
                    asset: asset, font: .system(size: 11),
                    idPrefix: "browseGrid.rename.\(asset.displayName)"
                )
                .padding(6)
                .id(asset.id)
            } else {
                Text(asset.fullFilename)
                    .font(.system(size: 11))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .shadow(color: .black.opacity(0.8), radius: 2)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 4)
                    .contentShape(Rectangle())
                    .onTapGesture(count: 2) { renameCtx?.begin(asset) }
                    .accessibilityIdentifier("browseGrid.filename.\(asset.displayName)")
                    .accessibilityHint(renameCtx?.unsupportedReason(asset) ?? "Double-click to rename")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(captionBackground)
    }

    @ViewBuilder
    private var captionBackground: some View {
        if isEditing {
            MapleTokens.surface.opacity(0.94)
        } else {
            LinearGradient(
                colors: [.black.opacity(0), .black.opacity(0.6)],
                startPoint: .top, endPoint: .bottom
            )
        }
    }
}

// MARK: - Previews

#Preview("GridCellRenameCaption — display") {
    GridCellRenameCaption(asset: .preview(displayName: "IMG_0001.dng"))
        .frame(width: 180)
        .background(MapleTokens.surfaceAlt)
}
