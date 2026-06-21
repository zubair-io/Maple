// SearchPhotoResultsSection.swift — full 3-col results grid for S7 (#622).
//
// Spec: docs/design/responsive-program/s7-search.md §2 "PHOTOS · {count}".
//
// Eyebrow ("PHOTOS · {count}") then the full result set in a 3-col grid with
// infinite-scroll pagination — the last loaded tile's appearance asks the host
// to page in the next batch. (The old capped 9-tile preview + "See all" hop was
// dropped: the results ARE the page, so there's nowhere separate to "see all".)
// Stale state (debounced fetch in flight) dims the grid to 60% opacity.

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
    /// Called when the last loaded tile appears — the host pages in more
    /// results (the host's loader no-ops once the full set is loaded).
    var onLoadMore: () -> Void = {}
    /// True while the next page is in flight — drives the footer spinner.
    var isLoadingMore: Bool = false
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
                Text("PHOTOS \u{00B7} \(total)")
                    .font(.custom("Lato-Bold", size: 10))
                    .tracking(0.6)
                    .foregroundStyle(MapleTokens.textMuted)

                LazyVGrid(columns: columns, spacing: 4) {
                    ForEach(results) { tile in
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
                        // Infinite scroll: pull the next page when the last
                        // loaded tile scrolls into view.
                        .onAppear {
                            if tile.id == results.last?.id { onLoadMore() }
                        }
                    }
                }
                .opacity(isStale ? 0.6 : 1.0)
                .animation(.linear(duration: 0.12), value: isStale)

                if isLoadingMore {
                    ProgressView()
                        .controlSize(.small)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
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
        onTap: { _ in }
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
        onTap: { _ in }
    )
    .padding()
    .background(MapleTokens.bg)
}

#endif
