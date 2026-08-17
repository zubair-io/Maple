// BrowseGrid+Rename.swift — Browse grid's "Rename" context-menu item
// (#2842). Split out of BrowseGrid.swift, which is already large (see
// `tools/budget-allowlist.txt`), rather than growing it further.
//
// Follows the same explain-don't-hide rule the existing trash/reveal items
// already use: a source the `\.assetRename` action can't rename (PhotoKit,
// an unresolved Cloud asset) still gets a menu row, but a non-actionable
// explanation instead of a working button — reusing
// `AssetRenameContext.unsupportedReason`, which wraps AppShell's
// `renameUnsupportedReason(for:)` (`AppShell+AssetRename.swift`), rather
// than re-deriving new copy for the same rule.

import SwiftUI
import MapleCore

extension BrowseGrid {
    /// "Rename…" context-menu item for one cell. Multi-select has no
    /// obvious single target for a filename prompt (same reasoning
    /// `BrowseKeyboardShortcuts`' Enter-key handler already applies —
    /// batch rename is the separate #2641 flow), so this only ever
    /// begins a rename for the right-clicked asset itself, never a whole
    /// active selection like the trash/reveal items do.
    @ViewBuilder
    func renameMenuItem(for asset: AssetRef, renameCtx: AssetRenameContext) -> some View {
        if let reason = renameCtx.unsupportedReason(asset) {
            Text(reason)
        } else {
            Button {
                renameCtx.begin(asset)
            } label: {
                Label("Rename…", systemImage: "pencil")
            }
            .accessibilityIdentifier("browseGrid.rename.\(asset.displayName)")
        }
    }
}
