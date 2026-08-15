// SearchView.swift — responsive-program S7 (#622) Search content.
//
// Phone layout: the search FIELD and the bottom navigation are both the
// native system tab bar (iOS 26 `Tab(role: .search)` + `.searchable` +
// `.tabBarMinimizeBehavior`, wired in `PhoneTabShell`), so they're the same
// element as the Library / Settings tabs. This view is just the *content*
// under the search field: the unified filter row (#2866 — active chips +
// Filters button opening the Date/People/Places sheet) plus either recent
// queries (idle) or the paginated result grid. The live query text is
// owned by the host's `.searchable` and passed in as a binding.
//
// State:
//   • `query` — the live text (binding from `.searchable`). A 250ms debounce
//     drives a `SearchViewModel` submission when a `vm` is injected.
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
    /// Result tap — the host opens the asset (Preview first, per Fast
    /// Preview §1).
    var onSelectAsset: (SearchAsset) -> Void = { _ in }

    @State private var isStale: Bool = false
    @State private var showFilters = false
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

    /// A filters-only search (empty text, Date/People/Places set) is a
    /// real search — it must fetch and show results, not recents.
    private var filtersActive: Bool { viewModel?.hasUnifiedFilters ?? false }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let viewModel {
                    filterRow(viewModel)
                }

                if trimmedQuery.isEmpty && !filtersActive {
                    SearchRecentQueries(recent: recent, onTap: tapRecent)
                } else {
                    SearchPhotoResultsSection(
                        results: results,
                        total: total,
                        isStale: isStale,
                        hasQuery: true,
                        query: query,
                        onTap: { asset in
                            commitRecent()
                            onSelectAsset(asset)
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
        .onChange(of: query) { _, _ in scheduleSearch() }
        .onAppear {
            // The session / view model can arrive AFTER the user has already
            // typed (the `.searchable` field lives above this view and is
            // live while the session loads). Re-issue any pending query so it
            // isn't stranded showing no results until the next keystroke.
            if !trimmedQuery.isEmpty { scheduleSearch() }
            // The filter sheet's People / Places rows come from the facets
            // response, and an empty-query Search tab never submits — warm
            // them here so the panel is usable without a query (#2879).
            Task { await viewModel?.loadFacetsIfNeeded() }
        }
        .onDisappear { debounceTask?.cancel() }
        .sheet(isPresented: $showFilters) {
            if let viewModel {
                SearchFilterPanel(vm: viewModel, onClose: { showFilters = false })
                    .presentationDetents([.large])
                    // Covers the case where the session (and so the view
                    // model) arrived after `onAppear` ran; a no-op once the
                    // facets are loaded.
                    .task { await viewModel.loadFacetsIfNeeded() }
            }
        }
    }

    // MARK: - Filter row

    /// Active chips + the Filters control (badge = active count) that
    /// opens the unified Date/People/Places sheet.
    private func filterRow(_ vm: SearchViewModel) -> some View {
        HStack(spacing: 8) {
            SearchActiveFilterChips(vm: vm, onOpenFilters: { showFilters = true })
            Spacer(minLength: 0)
            filtersButton(vm)
        }
    }

    private func filtersButton(_ vm: SearchViewModel) -> some View {
        Button {
            showFilters = true
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "line.3.horizontal.decrease.circle")
                Text("Filters")
                    .font(MapleTokens.Typography.chipLabel)
                if vm.unifiedFilterCount > 0 {
                    Text("\(vm.unifiedFilterCount)")
                        .font(MapleTokens.Typography.chipLabel)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(MapleTokens.primary, in: Capsule())
                }
            }
            .foregroundStyle(vm.unifiedFilterCount > 0 ? MapleTokens.primary : MapleTokens.textMain)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(MapleTokens.surfaceAlt, in: Capsule())
            .overlay(Capsule().stroke(MapleTokens.border, lineWidth: 0.5))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(vm.unifiedFilterCount > 0
                            ? "Filters, \(vm.unifiedFilterCount) active" : "Filters")
        .accessibilityIdentifier("search-filters")
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

    /// Debounce keystrokes into one submission 250ms after the last change.
    /// An empty query with no active filters resets to idle; with filters
    /// set it still fetches (a filters-only search is a real search).
    private func scheduleSearch() {
        debounceTask?.cancel()
        let trimmed = trimmedQuery
        guard !trimmed.isEmpty || filtersActive else {
            isStale = false
            return
        }
        isStale = true
        debounceTask = Task { [viewModel] in
            try? await Task.sleep(for: .milliseconds(250))
            if Task.isCancelled { return }
            await MainActor.run {
                viewModel?.params.placeQuery = trimmed
            }
            // A trailing-whitespace edit leaves `trimmed` — and so the whole
            // param set — unchanged; `submitIfChanged` skips the redundant
            // round-trip in that case.
            await viewModel?.submitIfChanged()
            await MainActor.run { isStale = false }
        }
    }
}

#Preview("SearchView — empty state") {
    NavigationStack {
        SearchView(query: .constant(""))
    }
}

#endif
