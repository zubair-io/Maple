// CloudSearchView.swift
//
// Native port of the web search page (search.component). A top search bar
// (free-text query + sort + filters) over a flat grid of result cells.
// Reuses the cloud Timeline's `CloudTimelineCell` (cloud thumb fetch +
// rating overlay) so search results render identically to the rest of the
// cloud library, and routes taps through the same `onSelectAsset` →
// `openCloudAsset` path the Timeline uses.
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

  private let columns = Array(
    repeating: GridItem(.flexible(), spacing: 6),
    count: CloudTimelineViewVM.columnCount)

  var body: some View {
    VStack(spacing: 0) {
      searchBar
      Divider().overlay(MapleTokens.border)
      resultsArea
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
      TextField("Search filenames + paths…", text: $vm.params.q)
        .textFieldStyle(.plain)
        .foregroundStyle(MapleTokens.textMain)
        .onChange(of: vm.params.q) { _, _ in vm.queryChanged() }
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
        if vm.hasActiveFilters {
          Circle().fill(MapleTokens.primary).frame(width: 6, height: 6)
        }
      }
      .foregroundStyle(vm.hasActiveFilters ? MapleTokens.primary : MapleTokens.textMuted)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Filters")
    .accessibilityIdentifier("search-filters")
    .popover(isPresented: $showFilters, arrowEdge: .top) {
      SearchFilterPanel(vm: vm)
        .frame(minWidth: 320, idealWidth: 340, maxWidth: 380,
               minHeight: 420, idealHeight: 520)
    }
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
            .font(MapleTokens.Typography.meta)
            .foregroundStyle(MapleTokens.textMuted)
          Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)

        LazyVGrid(columns: columns, spacing: 6) {
          ForEach(vm.results, id: \.id) { asset in
            CloudTimelineCell(
              asset: asset,
              thumbClient: thumbClient,
              thumbCache: thumbCache,
              host: vm.server.cacheHostKey,
              displayMode: displayMode,
              onSelect: { onSelectAsset(asset) })
              // Infinite scroll — when the last visible cell appears,
              // pull the next page.
              .onAppear {
                if asset.id == vm.results.last?.id {
                  Task { await vm.loadMore() }
                }
              }
          }
        }
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
        .font(MapleTokens.Typography.emptyPrimary)
        .foregroundStyle(MapleTokens.textMain)
      Text(detail)
        .font(MapleTokens.Typography.emptySecondary)
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
