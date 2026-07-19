// src/apple/Maple TV/SearchScreen.swift
import MapleCloudKit
import SwiftUI

/// The Search screen (#2120 E2): a text-entry field at the top driving the
/// kit's `SearchViewModel` (reused AS-IS — see `TVCloudSession.searchClient`'s
/// doc comment, which documents this exact construction), over a flat,
/// uniform-cell results grid. Selecting a result presents
/// `PhotoViewerScreen` scoped to the current result set — the same
/// selection wiring `TimelineScreen` uses for D6, just against
/// `viewModel.results` instead of the day-flattened Timeline set.
///
/// Milestone F's tab bar will host this screen in the Search tab; that
/// wire-up is reconciled at merge, not this screen's job. This screen is
/// self-contained and takes exactly what `TimelineScreen` takes (a
/// session + a resolved library id), so hosting it is a drop-in.
struct SearchScreen: View {
  let session: TVCloudSession
  let libraryID: String

  @State private var viewModel: SearchViewModel
  /// Presents `PhotoViewerScreen` (current result set + selected index)
  /// via `.fullScreenCover(item:)` when non-nil — mirrors
  /// `TimelineScreen.selectedAsset`.
  @State private var selectedAsset: SearchAsset?
  /// Which cell should hold tvOS remote focus. Only ever SET by this
  /// screen; `PhotoViewerScreen.onDismiss` writes the asset that was
  /// actually on screen when Menu was pressed, matching
  /// `TimelineScreen.focusedCellID`'s contract.
  @FocusState private var focusedCellID: String?

  init(session: TVCloudSession, libraryID: String) {
    self.session = session
    self.libraryID = libraryID
    _viewModel = State(initialValue: SearchViewModel(
      server: session.server,
      libraryID: libraryID,
      searchClient: session.searchClient
    ))
  }

  /// Fixed-width columns matching `TimelineCell.size` — same uniform,
  /// non-adaptive grid shape as the Timeline (Global Constraint).
  private static let columns = [GridItem(.adaptive(minimum: TimelineCell.size, maximum: TimelineCell.size), spacing: 32)]

  /// How many trailing cells from the end of the loaded set trigger the
  /// next page. Wider than a single row so paging kicks in before the
  /// user's focus actually reaches the last loaded cell (matches the
  /// spirit of `TimelineScreen`'s "last two day sections" look-ahead,
  /// scaled to a flat per-cell grid instead of per-section).
  private static let pageAheadThreshold = 12

  var body: some View {
    ZStack {
      MapleTVTheme.background.ignoresSafeArea()
      VStack(alignment: .leading, spacing: 0) {
        searchField
        content
      }
    }
    .fullScreenCover(item: $selectedAsset) { asset in
      let resultSet = viewModel.results
      let startIndex = resultSet.firstIndex(where: { $0.id == asset.id }) ?? 0
      PhotoViewerScreen(
        // Falls back to a single-asset list only in the practically
        // unreachable case where `asset` isn't in `resultSet` at
        // cover-render time — mirrors `TimelineScreen`'s same fallback.
        assets: resultSet.isEmpty ? [asset] : resultSet,
        startIndex: startIndex,
        session: session,
        onDismiss: { viewedAsset in focusedCellID = viewedAsset.id }
      )
    }
  }

  // MARK: - Search field

  /// `viewModel.params.placeQuery` is the free-text field the main search
  /// box drives (see `SearchParams.placeQuery`'s doc comment — NOT `.q`,
  /// which is a filename/path substring field not wired to any platform's
  /// main box). A hand-rolled `Binding` (rather than `@Bindable`) keeps
  /// the write path in one place: every edit updates `params.placeQuery`
  /// and, for non-empty text, calls the kit's own debounced
  /// `queryChanged()` (250ms, generation-guarded — see `SearchViewModel`).
  /// An edit down to empty/whitespace does NOT call `queryChanged()` — no
  /// network round-trip for "the user cleared the box" — `content` reads
  /// `trimmedQuery` and falls back to `idleView` in that case regardless
  /// of whatever the last non-empty query left in `viewModel.results`.
  ///
  /// tvOS's system on-screen keyboard (and Siri Remote dictation, which
  /// rides the same system keyboard) comes for free from `TextField` —
  /// no `.searchable` needed. Dictation itself isn't verifiable from the
  /// Simulator (no microphone input path); confirmed the keyboard
  /// presents on focus, noted as a device-only check in the report.
  private var queryBinding: Binding<String> {
    Binding(
      get: { viewModel.params.placeQuery },
      set: { newValue in
        viewModel.params.placeQuery = newValue
        guard !newValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        viewModel.queryChanged()
      }
    )
  }

  private var searchField: some View {
    HStack(spacing: 16) {
      Image(systemName: "magnifyingglass")
        .foregroundStyle(MapleTVTheme.textMuted)
        .accessibilityHidden(true)
      TextField("Search your photos", text: queryBinding)
        .textFieldStyle(.plain)
        .font(.system(size: 24))
        .foregroundStyle(MapleTVTheme.textPrimary)
        .accessibilityIdentifier("tv-search-field")
        .accessibilityLabel("Search your photos")
        .onSubmit(submitIfNonEmpty)
      if viewModel.isLoading {
        ProgressView()
          .tint(MapleTVTheme.textPrimary)
          .accessibilityHidden(true)
      }
    }
    .padding(.horizontal, 28)
    .padding(.vertical, 18)
    .background(MapleTVTheme.surface)
    .clipShape(RoundedRectangle(cornerRadius: 14))
    .padding(.horizontal, 72)
    .padding(.top, 48)
    .padding(.bottom, 32)
  }

  /// Immediate (non-debounced) submit for the Return/Search key — mirrors
  /// `CloudSearchView`'s `.onSubmit`. No-ops on empty/whitespace so
  /// pressing Return in an untouched field can't fire a request the idle
  /// state is deliberately suppressing.
  private func submitIfNonEmpty() {
    guard !trimmedQuery.isEmpty else { return }
    Task { await viewModel.submit() }
  }

  private var trimmedQuery: String {
    viewModel.params.placeQuery.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  // MARK: - Content states

  /// Order matters, same as `TimelineScreen.content`: an empty query
  /// always wins (idle), then a load in flight with nothing to show yet,
  /// then a failed load with nothing cached, then the genuinely-empty
  /// steady state, then the grid. A `loadError` alongside non-empty
  /// `results` (a `loadMore()` page failed after earlier pages already
  /// rendered) deliberately falls through to `grid` — already-loaded
  /// results stay up rather than being replaced by a full-screen error.
  @ViewBuilder
  private var content: some View {
    if trimmedQuery.isEmpty {
      idleView
    } else if viewModel.isLoading, viewModel.results.isEmpty {
      loadingView
    } else if let error = viewModel.loadError, viewModel.results.isEmpty {
      errorView(error)
    } else if viewModel.results.isEmpty {
      emptyView
    } else {
      grid
    }
  }

  private var idleView: some View {
    VStack(spacing: 16) {
      Image(systemName: "magnifyingglass")
        .font(.system(size: 56))
        .foregroundStyle(MapleTVTheme.textMuted)
        .accessibilityHidden(true)
      Text("Search your photos")
        .font(.system(size: 28, weight: .semibold))
        .foregroundStyle(MapleTVTheme.textPrimary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Search your photos")
  }

  private var loadingView: some View {
    ProgressView("Searching…")
      .tint(MapleTVTheme.textPrimary)
      .foregroundStyle(MapleTVTheme.textPrimary)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .accessibilityLabel("Searching")
  }

  /// Mirrors `TimelineScreen.errorView`'s shape (icon + title + message +
  /// Retry), scoped to the search vocabulary. Deliberately not
  /// `.accessibilityElement(children: .combine)` (same reasoning as
  /// `TimelineScreen`) so focus/select still lands on the Retry button.
  private func errorView(_ error: Error) -> some View {
    VStack(spacing: 16) {
      Image(systemName: "wifi.exclamationmark")
        .font(.system(size: 56))
        .foregroundStyle(MapleTVTheme.primary)
        .accessibilityHidden(true)
      Text("Search failed")
        .font(.system(size: 28, weight: .semibold))
        .foregroundStyle(MapleTVTheme.textPrimary)
      Text(error.localizedDescription)
        .font(.system(size: 20))
        .foregroundStyle(MapleTVTheme.textMuted)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 560)
      Button("Retry") { Task { await viewModel.submit() } }
        .accessibilityLabel("Retry search")
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var emptyView: some View {
    VStack(spacing: 16) {
      Image(systemName: "photo.on.rectangle.angled")
        .font(.system(size: 56))
        .foregroundStyle(MapleTVTheme.textMuted)
        .accessibilityHidden(true)
      Text("No results for “\(trimmedQuery)”")
        .font(.system(size: 28, weight: .semibold))
        .foregroundStyle(MapleTVTheme.textPrimary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 560)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("No results for \(trimmedQuery)")
  }

  // MARK: - Results grid

  /// Flat grid — no day grouping (that's the Timeline's shape, not
  /// search's). Reuses `TimelineCell` directly per the Global Constraint
  /// (uniform ~178pt crop-fill cells, focus scale + red ring, same
  /// caption on focus) rather than a parallel cell type.
  private var grid: some View {
    ScrollView {
      LazyVGrid(columns: Self.columns, alignment: .leading, spacing: 32) {
        let results = viewModel.results
        ForEach(Array(results.enumerated()), id: \.element.id) { index, asset in
          TimelineCell(
            asset: asset,
            server: session.server,
            thumbClient: session.thumbClient,
            thumbCache: session.thumbCache,
            identifier: "search-cell-\(asset.id)",
            onSelect: { selectedAsset = asset }
          )
          .focused($focusedCellID, equals: asset.id)
          .onAppear {
            guard viewModel.canLoadMore, index >= results.count - Self.pageAheadThreshold else { return }
            Task { await viewModel.loadMore() }
          }
        }
      }
      .padding(.horizontal, 72)
      .padding(.top, 8)
      .padding(.bottom, 72)
    }
  }
}

// No `#Preview` here: `TVCloudSession` builds a real `AuthenticatedHTTPClient`
// with no lightweight `.preview()` factory — matching `PhotoViewerScreen`,
// `ConnectedScreen`, and `TimelineScreen`, none of which carry a `#Preview`
// for the same reason (see `PhotoViewerScreen`'s trailing comment).
