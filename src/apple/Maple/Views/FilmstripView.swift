// FilmstripView.swift — responsive-program S5a (#625).
//
// 44pt thumbnails, scroll-snap-center, 1.5pt accent inset on the active
// asset. v0.1 renders solid color tiles keyed off `AssetRef.id` — real
// thumbnail loading wires onto `ThumbnailLoader` in a follow-up (the S4
// Loupe drop removed the shared filmstrip primitive that would have
// owned that wiring).
//
// Spec: docs/design/responsive-program/s5-editor.md §2.

import SwiftUI
import MapleCore

struct FilmstripView: View {
    let assets: [AssetRef]
    let activeID: AssetRef.ID?
    let onSelect: (AssetRef) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(assets, id: \.id) { asset in
                    let isActive = asset.id == activeID
                    Button {
                        onSelect(asset)
                    } label: {
                        ZStack {
                            RoundedRectangle(cornerRadius: 2)
                                .fill(MapleTokens.surfaceAlt)
                            if isActive {
                                RoundedRectangle(cornerRadius: 2)
                                    .strokeBorder(MapleTokens.primary, lineWidth: 1.5)
                            }
                        }
                        .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(asset.displayName)
                    .accessibilityAddTraits(isActive ? .isSelected : [])
                }
            }
            .padding(.horizontal, 12)
        }
        .frame(height: 48)
        .background(MapleTokens.bg)
        .accessibilityIdentifier("editor-filmstrip")
    }
}
