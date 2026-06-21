// SearchView.swift — responsive-program S7 (#622) Search content.
//
// Spec: docs/design/responsive-program/s7-search.md §3 "Apple".
//
// One top-level view used at every breakpoint:
//   • Phone — placed inside the Search tab's NavigationStack
//     (replaces `PhoneSearchStub`).
//   • Tablet / Desktop — presented as an overlay anchored to the sidebar
//     search pill (popover-style; the caller decides the anchor).
//
// State:
//   • `query` — the live text. 250ms debounce drives a `SearchViewModel`
//     submission today (when a `vm` is injected); otherwise the view
//     renders empty-state and recent queries only. That keeps the view
//     drop-in usable in `PhoneSearchStub` even before the S1a wiring
//     attaches a real `SearchViewModel`.
//   • `scope` — `SearchScope` enum chip selection. v0.1 only `all` /
//     `photos` route to a real call (same params); the others are
//     stubbed pending a backend `scope` extension (spec §6 Risks).
//   • `recent` — JSON-encoded `[String]` in `@AppStorage("cm.search.recent")`,
//     capped at 10, dedup'd, most-recent-first.
//
// Auto-focus: `onAppear` plus the `.mapleFocusSearch` notification emitted
// by `AppShellIPhoneDrawer` when the user taps the source-picker drawer's
// search pill. The notification name was declared in #600 specifically
// for this listener.

#if os(iOS)

import SwiftUI
import MapleCore
import Combine

struct SearchView: View {
    /// Optional view model — when nil the view runs in "shell" mode
    /// (renders the UI scaffold but doesn't issue search calls). This
    /// lets the phone Search tab render before a backing index exists.
    var viewModel: SearchViewModel?
    /// Cloud thumb client + cache for result thumbnails. nil → placeholders.
    var thumbClient: CloudThumbClient?
    var thumbCache: CloudThumbCache?
    var onSelectAsset: (SearchAsset) -> Void = { _ in }

    @State private var query: String = ""
    @State private var scope: SearchScope = .all
    @State private var isStale: Bool = false
    @AppStorage("cm.search.recent") private var recentJSON: String = "[]"

    @FocusState private var searchFocused: Bool

    /// Debounces query → SearchViewModel submission. Recreated whenever
    /// `query` changes; the prior task is cancelled so a slow first
    /// submission can't overwrite a fast second one.
    @State private var debounceTask: Task<Void, Never>? = nil

    private var recent: [String] { decodeRecents(recentJSON) }

    private var results: [SearchAsset] { viewModel?.results ?? [] }
    private var total: Int { viewModel?.total ?? 0 }

    private var thumbContext: SearchThumbContext? {
        guard let vm = viewModel, let client = thumbClient, let cache = thumbCache else { return nil }
        return SearchThumbContext(client: client, cache: cache, host: vm.server.cacheHostKey)
    }

    private var resultTiles: [SearchResultTile] {
        results.map { SearchResultTile(id: $0.id, displayName: $0.filename, absPath: $0.abs_path) }
    }

    private var topHits: [SearchTopHit] {
        results.prefix(3).map { asset in
            let camera = [asset.camera?.make ?? "", asset.camera?.model ?? ""]
                .filter { !$0.isEmpty }
                .joined(separator: " ")
            return SearchTopHit(
                id: asset.id,
                kind: .photo,
                label: asset.filename,
                subLabel: camera.isEmpty ? nil : camera,
                assetID: asset.id,
                absPath: asset.abs_path
            )
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                SearchBar(
                    query: $query,
                    onSubmit: commitRecent,
                    onClear: clearQuery,
                    isFocused: $searchFocused
                )

                SearchScopeChips(scope: $scope)
                    .onChange(of: scope) { _, _ in scheduleSearch(force: true) }

                if query.isEmpty {
                    SearchRecentQueries(recent: recent, onTap: tapRecent)
                } else {
                    SearchTopHitsSection(hits: topHits, query: query, onTap: tapTopHit, thumb: thumbContext)
                    SearchPhotoResultsSection(
                        results: resultTiles,
                        total: total,
                        isStale: isStale,
                        hasQuery: !query.isEmpty,
                        query: query,
                        onTap: tapTile,
                        onSeeAll: seeAll,
                        thumb: thumbContext
                    )
                }
            }
            .padding(12)
        }
        .background(MapleTokens.bg.ignoresSafeArea())
        .accessibilityIdentifier("search-root")
        .onAppear { searchFocused = true }
        .onChange(of: query) { _, _ in scheduleSearch(force: false) }
        .onReceive(NotificationCenter.default.publisher(for: .mapleFocusSearch)) { _ in
            searchFocused = true
        }
        .onDisappear { debounceTask?.cancel() }
    }

    // MARK: - Actions

    private func clearQuery() {
        query = ""
        searchFocused = true
    }

    private func tapRecent(_ q: String) {
        query = q
        // Promote to head on tap so the list reflects most-recent-first.
        recentJSON = encodeRecents(pushRecent(recent, q))
    }

    private func tapTile(_ tile: SearchResultTile) {
        commitRecent()
        if let asset = results.first(where: { $0.id == tile.id }) {
            onSelectAsset(asset)
        }
    }

    private func tapTopHit(_ hit: SearchTopHit) {
        guard hit.kind == .photo, let id = hit.assetID,
              let asset = results.first(where: { $0.id == id }) else { return }
        commitRecent()
        onSelectAsset(asset)
    }

    private func seeAll() {
        commitRecent()
        // No-op until a filtered grid view exists — spec §6.5 leaves
        // wiring to a follow-up.
    }

    private func commitRecent() {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
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
        let trimmed = query.trimmingCharacters(in: .whitespaces)
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
        SearchView()
    }
}

#endif
