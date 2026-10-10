// SearchGeneratedCollections.swift — idle-page generated-search cards (#4410).
//
// The library's daily generated searches ("Spooky Nights", "Seven Summers of
// Lake George") as a horizontal row of cover cards above Recents. A card's
// cover is the first photo of the card's filtered snapshot page
// (`GeneratedSearchCollectionsViewModel.covers`): stored ids behind the live
// hidden-people and screenshot filters, so no search runs and nothing hidden
// shows. An empty page leaves the placeholder tile. Tapping a card hands the host the card; the host opens the
// collection's own results (`SearchViewModel.showCollection`).

#if os(iOS)

  import MapleCore
  import SwiftUI

  struct SearchGeneratedCollections: View {
    let model: GeneratedSearchCollectionsViewModel
    let provider: ThumbnailProvider?
    let host: String
    /// The card whose results are being fetched; it shows a spinner.
    var openingID: String? = nil
    let onTap: (GeneratedSearchCard) -> Void

    private static let cardSide: CGFloat = 132
    private static let cardRadius: CGFloat = 14

    var body: some View {
      if !model.collections.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          Text("FOR YOU")
            .font(.custom("Lato-Bold", size: 10))
            .tracking(0.6)
            .foregroundStyle(MapleTokens.textMuted)

          ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
              ForEach(model.collections) { card in
                cardView(card)
              }
            }
          }
        }
      }
    }

    private func cardView(_ card: GeneratedSearchCard) -> some View {
      ZStack(alignment: .bottomLeading) {
        cover(for: card)
        LinearGradient(
          colors: [.clear, .black.opacity(0.65)],
          startPoint: .center,
          endPoint: .bottom
        )
        .allowsHitTesting(false)
        Text(card.title)
          .font(.custom("Lato-Bold", size: 13))
          .foregroundStyle(.white)
          .lineLimit(2)
          .padding(10)
          .allowsHitTesting(false)
        if card.id == openingID {
          ProgressView()
            .tint(.white)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.black.opacity(0.35))
            .allowsHitTesting(false)
        }
      }
      .frame(width: Self.cardSide, height: Self.cardSide)
      .clipShape(RoundedRectangle(cornerRadius: Self.cardRadius, style: .continuous))
      .contentShape(RoundedRectangle(cornerRadius: Self.cardRadius, style: .continuous))
      .onTapGesture { onTap(card) }
      .accessibilityElement(children: .ignore)
      .accessibilityAddTraits(.isButton)
      .accessibilityLabel(card.title)
      .accessibilityAction { onTap(card) }
      .accessibilityIdentifier("search-collection-\(card.id)")
    }

    @ViewBuilder
    private func cover(for card: GeneratedSearchCard) -> some View {
      if let asset = model.covers[card.id], let provider {
        PhotoThumbnailCell(
          item: PhotoGridItem(cloud: asset, host: host, style: .phone),
          provider: provider,
          displayMode: .fill,
          onTap: { _ in onTap(card) }
        )
      } else {
        MapleTokens.surfaceAlt
      }
    }
  }

#endif
