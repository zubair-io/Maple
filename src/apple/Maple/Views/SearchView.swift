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

  import MapleUI
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
    /// The library's generated searches, shown as cards on the idle page.
    var collections: GeneratedSearchCollectionsViewModel? = nil
    /// The card whose results are still being fetched, shown as busy.
    var openingCollectionID: String? = nil
    /// Card tap — the host opens the collection's results.
    var onSelectCollection: (GeneratedSearchCard) -> Void = { _ in }
    /// The text the host just set programmatically (deep link, Map pin,
    /// card), cleared by `onSeedApplied` once the change is observed. That
    /// change is a seed, not the user clearing the field, so a filters-only
    /// seed keeps its filters; a later user clear is not masked.
    var seededQuery: String? = nil
    var onSeedApplied: () -> Void = {}
    /// Result tap — the host opens the asset (Preview first, per Fast
    /// Preview §1).
    var onSelectAsset: (SearchAsset) -> Void = { _ in }

    /// True from a keystroke until its debounced submit lands — covers the
    /// 250ms window before `viewModel.isLoading` takes over.
    @State private var isDebouncing: Bool = false
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
            if let collections {
              SearchGeneratedCollections(
                model: collections,
                provider: thumbProvider,
                host: host,
                openingID: openingCollectionID,
                onTap: onSelectCollection)
            }
            SearchRecentQueries(recent: recent, onTap: tapRecent)
          } else {
            SearchPhotoResultsSection(
              results: results,
              total: total,
              isLoading: isDebouncing || (viewModel?.isLoading ?? false),
              // A failed later page keeps the pages already shown.
              failed: viewModel?.loadError != nil && results.isEmpty,
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
      .onChange(of: query) { previous, current in
        let isSeed = seededQuery != nil && current == seededQuery
        if isSeed { onSeedApplied() }
        // The field's clear button empties the text in one step, which
        // SwiftUI reports the same way as a backspace. A multi-character
        // drop to empty is the button; a single-character one is the user
        // editing (backspacing "a" to retype), and keeps the filters. On
        // the button, drop the filters too so the page returns to Recents
        // instead of re-running a filters-only search.
        let clearedByButton = current.isEmpty && previous.count > 1
        if !isSeed && clearedByButton && filtersActive {
          viewModel?.resetFilters()
        }
        scheduleSearch()
      }
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
      // Once per page lifetime: a tab re-appearance keeps today's cards.
      .task {
        guard let collections, collections.collections.isEmpty else { return }
        await collections.load()
      }
      .onDisappear {
        debounceTask?.cancel()
        isDebouncing = false
      }
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
          MuiIcon(name: "filter_list", size: .sm)
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
      .accessibilityLabel(
        vm.unifiedFilterCount > 0
          ? "Filters, \(vm.unifiedFilterCount) active" : "Filters"
      )
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
        isDebouncing = false
        return
      }
      // The host already put this text's results up (a tapped collection
      // card, a deep-link seed) — a debounce here would only flash the
      // spinner over them before `submitIfChanged` found nothing to do.
      guard trimmed != viewModel?.params.placeQuery else {
        isDebouncing = false
        return
      }
      isDebouncing = true
      debounceTask = Task { @MainActor [viewModel] in
        try? await Task.sleep(for: .milliseconds(250))
        // A newer keystroke cancelled this task and owns the flag now.
        guard !Task.isCancelled else { return }
        viewModel?.params.placeQuery = trimmed
        // Hand the spinner to `viewModel.isLoading` in this same main-actor
        // turn — `submit()` raises it before its first suspension, so there
        // is no gap — rather than after the submit returns, which also waits
        // out the slower facets request and hid results that had landed.
        isDebouncing = false
        // A trailing-whitespace edit leaves `trimmed` — and so the whole
        // param set — unchanged; `submitIfChanged` skips the redundant
        // round-trip in that case.
        await viewModel?.submitIfChanged()
      }
    }
  }

  #Preview("SearchView — empty state") {
    NavigationStack {
      SearchView(query: .constant(""))
    }
  }

#endif
