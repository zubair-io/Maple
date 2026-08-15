// CloudSearchView.swift
//
// Native port of the web search page (search.component). A top search bar
// (free-text query + sort + filters) over a flat grid of result cells.
// Uses the shared PhotoGrid with OverlayStyle.cloud so search results render
// identically to the cloud Timeline, and routes taps through the same
// `onSelectAsset` → `openCloudAsset` path the Timeline uses.
//
// Search is Maple-Cloud-only (the /api/search endpoint is auth-gated and
// server-backed). AppShell gates the toolbar entry point to cloud
// libraries and constructs the SearchViewModel + thumb client/cache.

import SwiftUI
import MapleCore

struct CloudSearchView: View {
  @Bindable var vm: SearchViewModel
  let thumbClient: CloudThumbClient
  let thumbCache: CloudThumbCache
  let displayMode: GridDisplayMode
  /// Tap target for a result — AppShell wires this to `openCloudAsset`.
  let onSelectAsset: (SearchAsset) -> Void
  /// Dismiss search and return to the library's normal view.
  let onClose: () -> Void

  @State private var showFilters = false
  @State private var provider: ThumbnailProvider

  init(vm: SearchViewModel,
       thumbClient: CloudThumbClient,
       thumbCache: CloudThumbCache,
       displayMode: GridDisplayMode,
       onSelectAsset: @escaping (SearchAsset) -> Void,
       onClose: @escaping () -> Void) {
    self.vm = vm
    self.thumbClient = thumbClient
    self.thumbCache = thumbCache
    self.displayMode = displayMode
    self.onSelectAsset = onSelectAsset
    self.onClose = onClose
    self._provider = State(initialValue: ThumbnailProvider(
      thumbClient: thumbClient, thumbCache: thumbCache))
  }

  var body: some View {
    HStack(spacing: 0) {
      VStack(spacing: 0) {
        searchBar
        if vm.hasUnifiedFilters {
          SearchActiveFilterChips(vm: vm, onOpenFilters: { showFilters = true })
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
        }
        Divider().overlay(MapleTokens.border)
        resultsArea
      }
      // Right-docked unified filter panel (#2866) — toggleable, beside the
      // results rather than floating over them.
      if showFilters {
        Divider().overlay(MapleTokens.border)
        SearchFilterPanel(vm: vm, onClose: { showFilters = false })
          .frame(width: 320)
      }
    }
    .background(MapleTokens.bg)
    // First appearance kicks an initial (empty-query) search so the user
    // sees the whole library, then refines. Skipped if results already
    // loaded (returning from the editor keeps the prior result set).
    .task {
      if vm.results.isEmpty && vm.loadError == nil && !vm.isLoading {
        await vm.submit()
      }
    }
  }

  // MARK: - Search bar

  private var searchBar: some View {
    HStack(spacing: 8) {
      Image(systemName: "magnifyingglass")
        .foregroundStyle(MapleTokens.textMuted)
      TextField("Search photos — people, places, things, dates…", text: $vm.params.placeQuery)
        .textFieldStyle(.plain)
        .foregroundStyle(MapleTokens.textMain)
        .onChange(of: vm.params.placeQuery) { _, _ in vm.queryChanged() }
        .onSubmit { Task { await vm.submit() } }
        .accessibilityIdentifier("search-field")

      if vm.isLoading {
        ProgressView().controlSize(.small)
      }

      sortMenu
      filtersButton

      Button(action: onClose) {
        Image(systemName: "xmark")
          .foregroundStyle(MapleTokens.textMuted)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Close search")
      .accessibilityIdentifier("search-close")
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
  }

  private var sortMenu: some View {
    Menu {
      ForEach(SearchSort.allCases, id: \.self) { option in
        Button {
          vm.params.sort = option
          Task { await vm.submit() }
        } label: {
          if vm.params.sort == option {
            Label(option.label, systemImage: "checkmark")
          } else {
            Text(option.label)
          }
        }
      }
    } label: {
      Image(systemName: "arrow.up.arrow.down")
        .foregroundStyle(MapleTokens.textMuted)
    }
    .menuIndicator(.hidden)
    .fixedSize()
    .accessibilityLabel("Sort")
  }

  private var filtersButton: some View {
    Button {
      showFilters.toggle()
    } label: {
      HStack(spacing: 4) {
        Image(systemName: "line.3.horizontal.decrease.circle")
        if vm.unifiedFilterCount > 0 {
          Text("\(vm.unifiedFilterCount)")
            .font(MapleTokens.Typography.chipLabel)
            .foregroundStyle(.white)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(MapleTokens.primary, in: Capsule())
        }
      }
      .foregroundStyle(vm.unifiedFilterCount > 0 ? MapleTokens.primary : MapleTokens.textMuted)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Filters")
    .accessibilityIdentifier("search-filters")
  }

  // MARK: - Results

  @ViewBuilder
  private var resultsArea: some View {
    if let err = vm.loadError, vm.results.isEmpty {
      statePane(icon: "exclamationmark.triangle",
                title: "Search failed",
                detail: err.localizedDescription)
    } else if vm.results.isEmpty && !vm.isLoading {
      statePane(icon: "magnifyingglass",
                title: "No matches",
                detail: "Try a different query or clear the filters.")
    } else {
      ScrollView {
        HStack {
          Text(countLabel)
            .font(MapleTokens.Typography.body)
            .foregroundStyle(MapleTokens.textMuted)
          Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)

        PhotoGrid(
          data: vm.results,
          columns: .fixed(CloudTimelineViewVM.columnCount, spacing: 6),
          provider: provider,
          displayMode: displayMode,
          onAppearItem: { asset in
            // Infinite scroll — when the last visible cell appears,
            // pull the next page.
            if asset.id == vm.results.last?.id {
              Task { await vm.loadMore() }
            }
          },
          onTap: { onSelectAsset($0) },
          makeItem: { asset in
            PhotoGridItem(
              cloud: asset,
              host: vm.server.cacheHostKey,
              style: .cloud)
          }
        )
        .accessibilityIdentifier("search-results-grid")
        .padding(.horizontal, 16)
        .padding(.vertical, 12)

        if vm.isLoadingMore {
          ProgressView().controlSize(.small).padding(.bottom, 16)
        }
      }
    }
  }

  private var countLabel: String {
    vm.total == 1 ? "1 result" : "\(vm.total) results"
  }

  private func statePane(icon: String, title: String, detail: String) -> some View {
    VStack(spacing: 12) {
      Image(systemName: icon)
        .font(.system(size: 40))
        .foregroundStyle(MapleTokens.textMuted)
      Text(title)
        .font(MapleTokens.Typography.sheetTitle)
        .foregroundStyle(MapleTokens.textMain)
      Text(detail)
        .font(MapleTokens.Typography.rowLabel)
        .foregroundStyle(MapleTokens.textMuted)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 360)
    }
    .padding(24)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(MapleTokens.bg)
  }
}

// MARK: - Previews

#Preview("Loaded") {
  CloudSearchView(
    vm: SearchViewModel.preview(.loaded),
    thumbClient: CloudThumbClient.preview(),
    thumbCache: CloudThumbCache.preview(),
    displayMode: .fill,
    onSelectAsset: { _ in },
    onClose: {})
  .frame(width: 820, height: 600)
}

#Preview("Empty") {
  CloudSearchView(
    vm: SearchViewModel.preview(.empty),
    thumbClient: CloudThumbClient.preview(),
    thumbCache: CloudThumbCache.preview(),
    displayMode: .fill,
    onSelectAsset: { _ in },
    onClose: {})
  .frame(width: 820, height: 600)
}
