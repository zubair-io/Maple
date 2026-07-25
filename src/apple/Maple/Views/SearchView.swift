// SearchView.swift — responsive-program S7 (#622) Search content.
//
// Phone layout: the search FIELD and the bottom navigation are both the
// native system tab bar (iOS 26 `Tab(role: .search)` + `.searchable` +
// `.tabBarMinimizeBehavior`, wired in `PhoneTabShell`), so they're the same
// element as the Library / Settings tabs. This view is just the *content*
// under the search field: the scope chips plus either recent queries (empty
// query) or the paginated result grid. The live query text is owned by the
// host's `.searchable` and passed in as a binding.
//
// State:
//   • `query` — the live text (binding from `.searchable`). A 250ms debounce
//     drives a `SearchViewModel` submission when a `vm` is injected.
//   • `scope` — `SearchScope` enum chip selection.
//   • `recent` — JSON-encoded `[String]` in `@AppStorage("cm.search.recent")`,
//     capped at 10, dedup'd, most-recent-first.

#if os(iOS)

import SwiftUI
import MapleCore

struct SearchView: View {
    /// Optional view model — when nil the view runs in "shell" mode
    /// (renders the UI scaffold but doesn't issue search calls).
    var viewModel: SearchViewModel?
    /// Cloud thumb client + cache for result thumbnails. nil → placeholders.
    var thumbClient: CloudThumbClient?
    var thumbCache: CloudThumbCache?
    /// Live query text, owned by the host's `.searchable` search field.
    @Binding var query: String
    /// Result tap. The second argument is the tapped cell's zoom-to-open
    /// source (#1489) — the thumbnail it is painting and the rect it occupies
    /// — so the host can fly it into the editor. `nil` when the cell hadn't
    /// loaded a thumbnail yet; the host opens with a plain fade instead.
    var onSelectAsset: (SearchAsset, PhotoGridHeroSource?) -> Void = { _, _ in }

    @State private var scope: SearchScope = .all
    @State private var isStale: Bool = false
    @AppStorage("cm.search.recent") private var recentJSON: String = "[]"

    /// Debounces query → SearchViewModel submission. Recreated whenever
    /// `query` changes; the prior task is cancelled so a slow first
    /// submission can't overwrite a fast second one.
    @State private var debounceTask: Task<Void, Never>? = nil

    private var recent: [String] { decodeRecents(recentJSON) }

    private var results: [SearchAsset] { viewModel?.results ?? [] }
    private var total: Int { viewModel?.total ?? 0 }

    /// ThumbnailProvider wired to the cloud thumb infra, or nil when no
    /// cloud session is available (shell mode / previews → grey placeholders).
    private var thumbProvider: ThumbnailProvider? {
        guard let client = thumbClient, let cache = thumbCache else { return nil }
        return ThumbnailProvider(thumbClient: client, thumbCache: cache)
    }

    /// Server cache-host key for `PhotoGridItem.cloud` namespace routing.
    private var host: String {
        viewModel?.server.cacheHostKey ?? ""
    }

    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                SearchScopeChips(scope: $scope)
                    .onChange(of: scope) { _, _ in scheduleSearch(force: true) }

                if trimmedQuery.isEmpty {
                    SearchRecentQueries(recent: recent, onTap: tapRecent)
                } else {
                    SearchPhotoResultsSection(
                        results: results,
                        total: total,
                        isStale: isStale,
                        hasQuery: true,
                        query: query,
                        onTap: { asset, hero in
                            commitRecent()
                            onSelectAsset(asset, hero)
                        },
                        onLoadMore: { Task { await viewModel?.loadMore() } },
                        isLoadingMore: viewModel?.isLoadingMore ?? false,
                        provider: thumbProvider,
                        host: host
                    )
                }
            }
            .padding(12)
        }
        .background(MapleTokens.bg.ignoresSafeArea())
        .accessibilityIdentifier("search-root")
        .onChange(of: query) { _, _ in scheduleSearch(force: false) }
        .onAppear {
            // The session / view model can arrive AFTER the user has already
            // typed (the `.searchable` field lives above this view and is
            // live while the session loads). Re-issue any pending query so it
            // isn't stranded showing no results until the next keystroke.
            if !trimmedQuery.isEmpty { scheduleSearch(force: false) }
        }
        .onDisappear { debounceTask?.cancel() }
    }

    // MARK: - Actions

    private func tapRecent(_ q: String) {
        query = q
        // Promote to head on tap so the list reflects most-recent-first.
        recentJSON = encodeRecents(pushRecent(recent, q))
    }

    private func commitRecent() {
        let trimmed = trimmedQuery
        guard !trimmed.isEmpty else { return }
        recentJSON = encodeRecents(pushRecent(recent, trimmed))
    }

    // MARK: - Search debounce

    /// Debounce keystrokes / scope changes into one submission 250ms after
    /// the last change. `force` shortcuts to an immediate fire for chip
    /// taps (the user expects scope changes to update the grid the moment
    /// the chip is selected, not 250ms later).
    private func scheduleSearch(force: Bool) {
        debounceTask?.cancel()
        let trimmed = trimmedQuery
        guard !trimmed.isEmpty else {
            isStale = false
            return
        }
        isStale = true
        debounceTask = Task { [scope, viewModel] in
            if !force {
                try? await Task.sleep(for: .milliseconds(250))
            }
            if Task.isCancelled { return }
            await MainActor.run {
                viewModel?.params.placeQuery = trimmed
                applyScopeParams(scope, on: viewModel)
            }
            await viewModel?.submit()
            await MainActor.run { isStale = false }
        }
    }

    /// Map the S7 scope chip into the server `scope` param. `all` / `photos`
    /// = the full live set (no scope token, matching the web + server, which
    /// treat absent and `photos` identically). `places` / `people` narrow
    /// server-side; `albums` is server-not-implemented (returns empty).
    private func applyScopeParams(_ scope: SearchScope, on vm: SearchViewModel?) {
        guard let vm else { return }
        switch scope {
        case .all, .photos: vm.params.scope = nil
        case .places:       vm.params.scope = "places"
        case .people:       vm.params.scope = "people"
        case .albums:       vm.params.scope = "albums"
        }
    }
}

#Preview("SearchView — empty state") {
    NavigationStack {
        SearchView(query: .constant(""))
    }
}

#endif
