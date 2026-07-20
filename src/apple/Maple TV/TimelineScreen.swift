// src/apple/Maple TV/TimelineScreen.swift
import MapleCloudKit
import SwiftUI

/// The Timeline: a flat, newest-first wall of photos (no day/location
/// section grouping). `RootTabView` (#2121) hosts it as one of three tabs
/// under the floating pill tab bar. The header (`TimelineTopBar`) reflects
/// the *focused* photo — its short capture date and, when geocoded, its
/// place — so the day and location live in one place that updates as you
/// move the Siri Remote, rather than as repeated in-grid section headers.
///
/// Owns a `TVTimelineViewModel` scoped to `libraryID`. Navigation (Back to
/// the Menu, Log Out) is handled by `RootTabView` / `MenuScreen`, so this
/// screen carries no chrome beyond the focused-photo header.
struct TimelineScreen: View {
  let session: TVCloudSession
  let libraryID: String
  let libraryName: String

  @State private var viewModel: TVTimelineViewModel
  /// Presents `PhotoViewerScreen` (current feed + selected index) via
  /// `.fullScreenCover(item:)` when non-nil. Set by a cell's `onSelect`.
  @State private var selectedAsset: SearchAsset?
  /// Which cell holds tvOS remote focus. Drives the header (focused photo's
  /// date + place) and is written back by `PhotoViewerScreen.onDismiss` so
  /// Menu returns to the grid at the asset that was on screen.
  @FocusState private var focusedCellID: String?

  init(session: TVCloudSession, libraryID: String, libraryName: String) {
    self.session = session
    self.libraryID = libraryID
    self.libraryName = libraryName
    _viewModel = State(initialValue: TVTimelineViewModel(
      server: session.server,
      libraryID: libraryID,
      searchClient: session.searchClient
    ))
  }

  /// Fixed-width columns matching `TimelineCell.size` — a wall of uniform
  /// square cells, not a proportional/adaptive layout.
  private static let columns = [GridItem(.adaptive(minimum: TimelineCell.size, maximum: TimelineCell.size), spacing: 32)]

  /// How many trailing cells from the end of the loaded feed trigger the
  /// next page — wide enough that paging kicks in before focus reaches the
  /// last loaded cell.
  private static let pageAheadThreshold = 24

  var body: some View {
    ZStack {
      MapleTVTheme.background.ignoresSafeArea()
      VStack(alignment: .leading, spacing: 0) {
        TimelineTopBar(title: headerTitle, subtitle: headerSubtitle)
        content
      }
    }
    // A plain (no-`id:`) `.task` is correct here ONLY because the caller
    // (`ConnectedScreen`) applies `.id(libraryID)` to this view — a library
    // switch gives `TimelineScreen` a fresh SwiftUI identity (and a fresh
    // `@State` viewModel scoped to the new library) rather than re-running
    // `load()` against a viewModel still bound to the old `libraryID`.
    .task { await viewModel.load() }
    .fullScreenCover(item: $selectedAsset) { asset in
      let resultSet = viewModel.assets
      let startIndex = resultSet.firstIndex(where: { $0.id == asset.id }) ?? 0
      PhotoViewerScreen(
        // Falls back to a single-asset list only in the practically
        // unreachable case where `asset` isn't in the feed at cover-render
        // time — the viewer should never fail to open for the tapped cell.
        assets: resultSet.isEmpty ? [asset] : resultSet,
        startIndex: startIndex,
        session: session,
        onDismiss: { viewedAsset in focusedCellID = viewedAsset.id }
      )
    }
  }

  // MARK: - Header (focused photo's date + place)

  /// The photo whose date/place the header shows: the focused cell, falling
  /// back to the newest (first) loaded photo before anything has focus.
  private var headerAsset: SearchAsset? {
    if let id = focusedCellID, let match = viewModel.assets.first(where: { $0.id == id }) {
      return match
    }
    return viewModel.assets.first
  }

  private var headerTitle: String {
    guard let asset = headerAsset, let dateText = Self.shortDate(asset.captured_at) else {
      // Before any photo has focus / while the feed loads, name the library
      // (e.g. "Photos") rather than a placeholder date.
      return libraryName
    }
    return dateText
  }

  private var headerSubtitle: String? {
    Self.placeText(headerAsset?.place)
  }

  // MARK: - Content states

  @ViewBuilder
  private var content: some View {
    // Order matters: loading first, then a failed-with-nothing-loaded load,
    // then the genuinely-empty steady state, then the grid. A `loadError`
    // alongside a non-empty feed (a later page failed after the first
    // rendered) falls through to `grid` — loaded photos stay up rather than
    // being replaced by a full-screen error.
    if viewModel.isLoading, viewModel.assets.isEmpty {
      loadingView
    } else if let error = viewModel.loadError, viewModel.assets.isEmpty {
      errorView(error)
    } else if viewModel.assets.isEmpty {
      emptyView
    } else {
      grid
    }
  }

  private var loadingView: some View {
    ProgressView("Loading photos…")
      .tint(MapleTVTheme.textPrimary)
      .foregroundStyle(MapleTVTheme.textPrimary)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .accessibilityLabel("Loading photos")
  }

  private func errorView(_ error: Error) -> some View {
    VStack(spacing: 16) {
      Image(systemName: "wifi.exclamationmark")
        .font(.system(size: 56))
        .foregroundStyle(MapleTVTheme.primary)
        .accessibilityHidden(true)
      Text("Couldn't load photos")
        .font(.system(size: 28, weight: .semibold))
        .foregroundStyle(MapleTVTheme.textPrimary)
      Text(error.localizedDescription)
        .font(.system(size: 20))
        .foregroundStyle(MapleTVTheme.textMuted)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 560)
      Button("Retry") { Task { await viewModel.load() } }
        .accessibilityLabel("Retry loading photos")
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var emptyView: some View {
    VStack(spacing: 16) {
      Image(systemName: "photo.on.rectangle.angled")
        .font(.system(size: 56))
        .foregroundStyle(MapleTVTheme.textMuted)
        .accessibilityHidden(true)
      Text("No photos yet")
        .font(.system(size: 28, weight: .semibold))
        .foregroundStyle(MapleTVTheme.textPrimary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("No photos yet")
  }

  private var grid: some View {
    ScrollView {
      LazyVGrid(columns: Self.columns, alignment: .center, spacing: 40) {
        let assets = viewModel.assets
        // Iterate indices rather than `Array(assets.enumerated())`: the latter
        // allocates a fresh array of tuples on every render, and tvOS
        // re-renders this grid on every focus move. Index-as-identity is safe
        // for THIS feed specifically — it only ever grows by appending a page
        // or is replaced wholesale by `load()`, never spliced in the middle —
        // so no cell's identity shifts under it. Focus is unaffected either
        // way: `.focused(equals:)` below keys on `asset.id`, not the index.
        ForEach(assets.indices, id: \.self) { index in
          let asset = assets[index]
          TimelineCell(
            asset: asset,
            server: session.server,
            thumbClient: session.thumbClient,
            thumbCache: session.thumbCache,
            identifier: "timeline-cell-\(asset.id)",
            onSelect: { selectedAsset = asset }
          )
          .focused($focusedCellID, equals: asset.id)
          .onAppear {
            guard viewModel.canLoadMore, index >= assets.count - Self.pageAheadThreshold else { return }
            Task { await viewModel.loadMore() }
          }
        }
      }
      // Cap the grid width and center it so a row of the larger cells sits in
      // the middle of the screen rather than left-packed against the edge.
      .frame(maxWidth: 1600)
      .frame(maxWidth: .infinity, alignment: .center)
      .padding(.horizontal, 72)
      .padding(.top, 8)
      .padding(.bottom, 72)
    }
  }

  // MARK: - Formatting

  /// "July 11, 2026" — the design's short date (no weekday), parsed with the
  /// fractional-seconds-tolerant `parseTimelineISO8601` (the server sends
  /// ms-precision `captured_at`; a bare `ISO8601DateFormatter` drops those,
  /// which is what left the whole timeline empty in D7).
  private static func shortDate(_ isoString: String?) -> String? {
    guard let isoString, let date = parseTimelineISO8601(isoString) else { return nil }
    return date.formatted(.dateTime.month(.wide).day().year())
  }

  /// Concise place string for the header: locality + (region or country
  /// code) from the geocode rollups, falling back to the server's own
  /// `display_name`. Returns nil when there's no usable place, so the
  /// header hides its subtitle rather than showing a blank line.
  private static func placeText(_ place: SearchAssetPlace?) -> String? {
    guard let place else { return nil }
    if let rollups = place.rollups {
      let parts = [rollups.locality, rollups.region ?? rollups.country_code]
        .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
      if !parts.isEmpty { return parts.joined(separator: ", ") }
    }
    let displayName = place.display_name?.trimmingCharacters(in: .whitespaces)
    return (displayName?.isEmpty == false) ? displayName : nil
  }
}
