// MuiDragPreview.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.7; Built from: Image, Badge). The ghost thumbnail shown under the
// cursor while dragging one or more assets — a slightly rotated, reduced-
// opacity card with a "+N" count badge when more than one item is being
// dragged. Purely presentational: the actual drag-and-drop wiring lives at
// the app layer and supplies this component's inputs.

import SwiftUI

public struct MuiDragPreview: View {
    public let url: URL?
    public let alt: String
    /// Total items being dragged; a badge appears once this is greater
    /// than 1.
    public let count: Int

    public init(url: URL?, alt: String = "Dragged item", count: Int = 1) {
        self.url = url
        self.alt = alt
        self.count = count
    }

    public var body: some View {
        ZStack(alignment: .topTrailing) {
            MuiImage(url: url, alt: alt, fit: .fill, radius: .md)
                .frame(width: 64, height: 64)
                .shadow(color: .black.opacity(0.35), radius: 8, y: 4)

            if count > 1 {
                MuiBadge(variant: .count, value: "\(count)")
                    .offset(x: 8, y: -8)
            }
        }
        .rotationEffect(.degrees(-4))
        .opacity(0.85)
        .accessibilityHidden(true)
    }
}

#Preview("MuiDragPreview") {
    HStack(spacing: 24) {
        MuiDragPreview(url: nil)
        MuiDragPreview(url: nil, count: 5)
    }
    .padding()
    .background(MuiTokens.bg)
}
