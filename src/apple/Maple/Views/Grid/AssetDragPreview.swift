// AssetDragPreview.swift — the visual that follows the cursor during a
// grid-tile drag (#2779). Wired from `PhotoThumbnailCell`'s
// `.draggable(_:preview:)` closure.
//
// Cheap by construction: reuses the cell's already-decoded thumbnail bitmap
// (no new decode) inside the existing `ThumbnailImage` renderer, at a small
// fixed size. A single-asset drag shows just the thumbnail; a multi-asset
// drag (the dragged tile was part of a larger active selection — see
// `BrowseGrid`'s `dragPayload` closure) overlays a "N Photos" count badge,
// matching the Finder/Photos convention the ticket asks for.

import SwiftUI
import MapleCore
import CoreGraphics

struct AssetDragPreview: View {
    /// The dragged tile's already-decoded thumbnail, or nil for the
    /// placeholder (not yet decoded — e.g. a fast drag on a cell that just
    /// scrolled into view). No decode work happens here.
    let thumbnail: CGImage?
    /// Total assets riding along in this drag (1 for a single tile, or the
    /// whole active selection's count). Only counts > 1 render the badge.
    let count: Int

    private static let side: CGFloat = 72

    var body: some View {
        ThumbnailImage(image: thumbnail, displayMode: .fill)
            .frame(width: Self.side, height: Self.side)
            .overlay(alignment: .bottomTrailing) {
                if count > 1 {
                    countBadge
                }
            }
    }

    private var countBadge: some View {
        Text(DraggedAssetPayload.previewBadgeText(forCount: count))
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(MapleTokens.primary, in: Capsule())
            .offset(x: 6, y: 6)
    }
}

#Preview("Single asset") {
    AssetDragPreview(thumbnail: nil, count: 1)
        .padding()
        .background(MapleTokens.bg)
}

#Preview("Multi-select — 12 photos") {
    AssetDragPreview(thumbnail: nil, count: 12)
        .padding()
        .background(MapleTokens.bg)
}
