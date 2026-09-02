// FilmstripView.swift — responsive-program S5a (#625).
//
// 44pt thumbnails, scroll-snap-center, 1.5pt accent inset on the active
// asset. Each cell loads its thumbnail via `ThumbnailLoader.shared`
// (the same embedded-preview fast path the Library grid uses), keyed off
// `AssetRef`; the active asset gets a `primary` 1.5pt inset stroke.
//
// Thumbnail loading goes through the shared `AsyncThumbnail` (#959): lazy
// load on appear, cancel the in-flight Task on disappear, memoise by asset
// id so cell recycling doesn't re-decode. Filesystem-backed assets load
// with `source == nil`; sourceless (cloud / self-hosted) assets need the
// source threaded in so `ThumbnailLoader`'s server / bytes-provider path
// can resolve them (#875 item 4a).
//
// Spec: docs/design/responsive-program/s5-editor.md §2.

import SwiftUI
import MapleCore

struct FilmstripView: View {
    let assets: [AssetRef]
    let activeID: AssetRef.ID?
    /// Source the assets came from — forwarded to `ThumbnailLoader` so the
    /// sourceless thumb path (cloud / PhotoKit / self-hosted) can resolve.
    /// `nil` for filesystem assets, which load straight off `primaryURL`.
    var source: (any ImageSource)? = nil
    let onSelect: (AssetRef) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(spacing: 4) {
                ForEach(assets, id: \.id) { asset in
                    FilmstripCell(
                        asset: asset,
                        isActive: asset.id == activeID,
                        source: source,
                        onSelect: onSelect
                    )
                }
            }
            .padding(.horizontal, 12)
        }
        .frame(height: 48)
        .background(MapleTokens.bg)
        .accessibilityIdentifier("editor-filmstrip")
    }
}

// MARK: - FilmstripCell

private struct FilmstripCell: View {
    let asset: AssetRef
    let isActive: Bool
    let source: (any ImageSource)?
    let onSelect: (AssetRef) -> Void

    var body: some View {
        Button {
            onSelect(asset)
        } label: {
            AsyncThumbnail(asset: asset, source: source) { decoded in
                ZStack {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(MapleTokens.surfaceAlt)

                    if let decoded {
                        Image(decorative: decoded, scale: 1)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                            .transition(.opacity)
                    }

                    if isActive {
                        RoundedRectangle(cornerRadius: 2)
                            .strokeBorder(MapleTokens.primary, lineWidth: 1.5)
                    }
                }
                .frame(width: 44, height: 44)
                // Clip the fill-scaled thumbnail to the rounded tile so it
                // doesn't bleed past the cell edges.
                .clipShape(RoundedRectangle(cornerRadius: 2))
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(asset.displayName)
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}
