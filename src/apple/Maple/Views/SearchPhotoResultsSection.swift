// SearchPhotoResultsSection.swift — 3-col preview grid for S7 (#622).
//
// Spec: docs/design/responsive-program/s7-search.md §2 "PHOTOS · {count}".
//
// Eyebrow + "See all" link on the same row, then up to 9 tiles in a
// 3-col grid. Stale state (debounced fetch in flight) dims the grid to
// 60% opacity.

#if os(iOS)

import SwiftUI
import MapleCore

/// Lightweight result tile — the host owns the source data and supplies
/// the id + display name so the renderer can stay decoupled from the
/// SearchAsset wire type.
struct SearchResultTile: Identifiable, Hashable {
    let id: String
    let displayName: String
    let absPath: String
}

struct SearchPhotoResultsSection: View {
    let results: [SearchResultTile]
    let total: Int
    let isStale: Bool
    let hasQuery: Bool
    let query: String
    let onTap: (SearchResultTile) -> Void
    let onSeeAll: () -> Void
    /// Live cloud session for thumbnails; nil → grey placeholders (previews).
    var thumb: SearchThumbContext? = nil

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 3)

    var body: some View {
        if hasQuery && results.isEmpty && !isStale {
            Text("No matches for \u{201C}\(query)\u{201D}")
                .font(.custom("Lato-Regular", size: 13))
                .foregroundStyle(MapleTokens.textMuted)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
                .accessibilityIdentifier("search-no-results")
        } else if !results.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    Text("PHOTOS \u{00B7} \(total)")
                        .font(.custom("Lato-Bold", size: 10))
                        .tracking(0.6)
                        .foregroundStyle(MapleTokens.textMuted)
                    Spacer()
                    Button("See all", action: onSeeAll)
                        .font(.custom("Lato-Bold", size: 11))
                        .foregroundStyle(MapleTokens.primary)
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("search-see-all")
                }

                LazyVGrid(columns: columns, spacing: 4) {
                    ForEach(results.prefix(9)) { tile in
                        Button {
                            onTap(tile)
                        } label: {
                            Group {
                                if let thumb {
                                    CloudThumbTile(
                                        absPath: tile.absPath,
                                        thumbClient: thumb.client,
                                        thumbCache: thumb.cache,
                                        host: thumb.host)
                                } else {
                                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                                        .fill(MapleTokens.surfaceAlt)
                                        .overlay(
                                            Image(systemName: "photo")
                                                .font(.system(size: 22))
                                                .foregroundStyle(MapleTokens.textMuted.opacity(0.5))
                                        )
                                }
                            }
                            .aspectRatio(1, contentMode: .fill)
                            .frame(maxWidth: .infinity)
                            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("search-tile-\(tile.id)")
                        .accessibilityLabel(tile.displayName)
                    }
                }
                .opacity(isStale ? 0.6 : 1.0)
                .animation(.linear(duration: 0.12), value: isStale)
            }
        }
    }
}

#Preview("Photos — populated") {
    SearchPhotoResultsSection(
        results: (1...6).map { SearchResultTile(id: "r\($0)", displayName: "img-\($0).dng", absPath: "/p/img-\($0).dng") },
        total: 42,
        isStale: false,
        hasQuery: true,
        query: "paris",
        onTap: { _ in },
        onSeeAll: {}
    )
    .padding()
    .background(MapleTokens.bg)
}

#Preview("Photos — empty (no matches)") {
    SearchPhotoResultsSection(
        results: [],
        total: 0,
        isStale: false,
        hasQuery: true,
        query: "nothing matches",
        onTap: { _ in },
        onSeeAll: {}
    )
    .padding()
    .background(MapleTokens.bg)
}

#endif
