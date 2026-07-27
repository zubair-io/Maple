// SearchPhotoResultsSection.swift — full 3-col results grid for S7 (#622).
//
// Spec: docs/design/responsive-program/s7-search.md §2 "PHOTOS · {count}".
//
// Eyebrow ("PHOTOS · {count}") then the full result set in a 3-col grid with
// infinite-scroll pagination — the last loaded tile's appearance asks the host
// to page in the next batch. (The old capped 9-tile preview + "See all" hop was
// dropped: the results ARE the page, so there's nowhere separate to "see all".)
// Stale state (debounced fetch in flight) dims the grid to 60% opacity.
//
// M3 (#1490): migrated from SearchResultTile placeholder tiles + CloudThumbTile
// to the shared PhotoGrid / PhotoThumbnailCell / ThumbnailProvider stack.
// Real cloud thumbnails are now rendered for every result cell.

#if os(iOS)

import SwiftUI
import MapleCore

struct SearchPhotoResultsSection: View {
    let results: [SearchAsset]
    let total: Int
    let isStale: Bool
    let hasQuery: Bool
    let query: String
    /// Result tap — the host opens the asset.
    let onTap: (SearchAsset) -> Void
    /// Called when the last loaded tile appears — the host pages in more
    /// results (the host's loader no-ops once the full set is loaded).
    var onLoadMore: () -> Void = {}
    /// True while the next page is in flight — drives the footer spinner.
    var isLoadingMore: Bool = false
    /// Cloud thumb provider. nil → grey placeholders (previews / no-session).
    var provider: ThumbnailProvider? = nil
    /// Server cache-host key for `PhotoGridItem.cloud` cache-namespace routing.
    /// Passed unconditionally by the host (it may be non-empty even when
    /// `provider` is nil); when `provider` is nil no thumbnails load, so its
    /// value is unused in that case (cells show grey placeholders).
    var host: String = ""

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

                PhotoGrid(
                    data: results,
                    columns: .fixed(3, spacing: 4),
                    provider: provider ?? .preview(),
                    displayMode: .fill,
                    onAppearItem: { asset in
                        if asset.id == results.last?.id { onLoadMore() }
                    },
                    onTap: onTap,
                    makeItem: { asset in
                        PhotoGridItem(cloud: asset, host: host, style: .phone)
                    }
                )
                .opacity(isStale ? 0.6 : 1.0)
                .animation(.linear(duration: 0.12), value: isStale)
                .accessibilityIdentifier("search-photo-grid")

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
        results: (1...6).map {
            SearchAsset(id: "r\($0)", folder_id: "f1",
                        abs_path: "/p/img-\($0).dng", filename: "img-\($0).dng")
        },
        total: 42,
        isStale: false,
        hasQuery: true,
        query: "paris",
        onTap: { _ in }
    )
    .padding()
    .background(MapleTokens.bg)
}

#Preview("Photos — stale (dimmed)") {
    SearchPhotoResultsSection(
        results: (1...6).map {
            SearchAsset(id: "r\($0)", folder_id: "f1",
                        abs_path: "/p/img-\($0).dng", filename: "img-\($0).dng")
        },
        total: 42,
        isStale: true,
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
