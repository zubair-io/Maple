// GridCellRenameCaption.swift — the Browse grid's inline rename editor (#2842). The Library
// thumbnail carries no filename (#5050): the name lives in the Info pane, which is also where a
// double-click renames. This overlay renders only while a rename is under way on the cell —
// started by Enter (`BrowseGrid`'s `BrowseKeyboardShortcuts`) or the per-cell context-menu item
// (`BrowseGrid+Rename.swift`) — and is the host that makes `renamingAssetID` render something
// there.
//
// Reuses `InlineRenameField` for the actual edit UI — no forked draft state, validation,
// extension-change warning, or error surfacing. Kept out of the shared `PhotoThumbnailCell` (used by
// merged timeline, CloudTimeline, and PhotoKit-only surfaces that have no rename concept) and
// instead plugged in through `PhotoGrid`'s `renameOverlay` hook, opt-in the same way
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
        if isEditing {
            InlineRenameField(
                asset: asset, font: .system(size: 11),
                idPrefix: "browseGrid.rename.\(asset.displayName)"
            )
            .padding(6)
            .id(asset.id)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(MapleTokens.surface.opacity(0.94))
        }
    }
}
