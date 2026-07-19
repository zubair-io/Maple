// src/apple/Maple TV/TimelineScreen.swift
import MapleCloudKit
import SwiftUI

/// The Timeline: day-grouped, focus-navigable photo grid. Milestone D
/// introduced this as the connected root by itself; `RootTabView` (#2121)
/// now wraps it as one of three tabs (Timeline / Light Table / Search)
/// under the design's floating pill tab bar — this screen is otherwise
/// unchanged.
///
/// Owns a `TVTimelineViewModel` scoped to `libraryID`; `onForgotten`
/// threads milestone C's pairing-reversal path through `TimelineTopBar`.
struct TimelineScreen: View {
  let session: TVCloudSession
  let libraryID: String
  let libraryName: String
  let onForgotten: () -> Void

  @State private var viewModel: TVTimelineViewModel
  /// Presents `PhotoViewerScreen` (current result set + selected index)
  /// via `.fullScreenCover(item:)` when non-nil. Set by a cell's
  /// `onSelect`; cleared automatically by SwiftUI when the cover's
  /// content calls its environment `dismiss()` (#2102 D6).
  @State private var selectedAsset: SearchAsset?
  /// Which cell should hold tvOS remote focus. Only ever SET by this
  /// screen (never read to drive layout) — `PhotoViewerScreen.onDismiss`
  /// writes the asset that was actually on screen when Menu was pressed,
  /// which may differ from `selectedAsset` if the user swiped to a
  /// different photo inside the viewer before backing out. That keeps
  /// "Menu returns to the grid at the same asset" true even after
  /// in-viewer navigation, not just for the originally-tapped cell.
  @FocusState private var focusedCellID: String?

  init(session: TVCloudSession, libraryID: String, libraryName: String, onForgotten: @escaping () -> Void) {
    self.session = session
    self.libraryID = libraryID
    self.libraryName = libraryName
    self.onForgotten = onForgotten
    _viewModel = State(initialValue: TVTimelineViewModel(
      server: session.server,
      libraryID: libraryID,
      searchClient: session.searchClient
    ))
  }

  /// Fixed-width columns matching `TimelineCell.size` — the grid is a
  /// wall of uniform square cells, not a proportional/adaptive layout.
  private static let columns = [GridItem(.adaptive(minimum: TimelineCell.size, maximum: TimelineCell.size), spacing: 32)]

  var body: some View {
    ZStack {
      MapleTVTheme.background.ignoresSafeArea()
      VStack(alignment: .leading, spacing: 0) {
        TimelineTopBar(
          libraryName: libraryName,
          serverDisplayName: serverDisplayName,
          onForgotten: onForgotten
        )
        content
      }
    }
    // A plain (no-`id:`) `.task` is correct here ONLY because the caller
    // (`ConnectedScreen`) applies `.id(libraryID)` to this view — a
    // library switch gives `TimelineScreen` a fresh SwiftUI identity
    // (and therefore a fresh `@State` viewModel scoped to the new
    // library) rather than re-running `load()` against a viewModel still
    // bound to the old `libraryID`.
    .task { await viewModel.load() }
    .fullScreenCover(item: $selectedAsset) { asset in
      let resultSet = flattenedAssets
      let startIndex = resultSet.firstIndex(where: { $0.id == asset.id }) ?? 0
      PhotoViewerScreen(
        // Falls back to a single-asset list only in the practically
        // unreachable case where `asset` isn't in `flattenedAssets` at
        // cover-render time (e.g. a same-frame day-section reload) — the
        // viewer should never fail to open for the cell the user just
        // pressed.
        assets: resultSet.isEmpty ? [asset] : resultSet,
        startIndex: startIndex,
        session: session,
        onDismiss: { viewedAsset in focusedCellID = viewedAsset.id }
      )
    }
  }

  /// The Timeline's current result set in display order: every loaded
  /// day section's assets, newest day first and each day's assets newest
  /// first (matches `TimelineDay`/`groupByDay`'s own ordering), flattened
  /// into one ordered list. `PhotoViewerScreen` navigates strictly within
  /// THIS set — no cross-day paging beyond what's already loaded (v1,
  /// Global Constraint, #2102).
  private var flattenedAssets: [SearchAsset] {
    viewModel.days.flatMap(\.assets)
  }

  private var serverDisplayName: String {
    CloudServerRegistry.shared.displayName(for: session.server)
      ?? CloudHost.parse(session.server.absoluteString)?.displayHost
      ?? session.server.host
      ?? session.server.absoluteString
  }

  @ViewBuilder
  private var content: some View {
    // Order matters: loading first, then a failed-with-nothing-cached
    // load (error && empty — the same conflation D5 fixed one layer up
    // in `ConnectedScreen.errorView`), then the genuinely-empty steady
    // state, then the grid. A `loadError` alongside a non-empty `days`
    // (a later page failed after the first page/months already
    // rendered) deliberately falls through to `grid` — the top bar and
    // already-loaded content stay up rather than being replaced by a
    // full-screen error.
    if viewModel.isLoading, viewModel.days.isEmpty {
      loadingView
    } else if let error = viewModel.loadError, viewModel.days.isEmpty {
      errorView(error)
    } else if viewModel.days.isEmpty {
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

  /// Mirrors `ConnectedScreen.errorView`'s shape (icon + title + message
  /// + Retry) at the timeline-content scale (matches this screen's own
  /// `loadingView`/`emptyView` sizing, smaller than `ConnectedScreen`'s
  /// full-page treatment since this sits below `TimelineTopBar` rather
  /// than replacing the whole screen).
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
    // No `.accessibilityElement(children: .combine)` here (unlike
    // `emptyView`, which has no interactive content) — combining would
    // fold the focusable Retry button into one non-interactive element
    // and tvOS focus/select would no longer land on it, matching
    // `ConnectedScreen.errorView`'s own uncombined VStack.
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
      LazyVStack(alignment: .leading, spacing: 40) {
        let days = viewModel.days
        ForEach(Array(days.enumerated()), id: \.element.id) { index, day in
          daySection(day)
            .onAppear {
              // Page ahead once focus/scroll nears the end of loaded
              // content — the last two loaded day sections are close
              // enough to the tail to trigger the next months.
              guard index >= days.count - 2 else { return }
              Task { await viewModel.loadMore(around: day) }
            }
        }
      }
      .padding(.horizontal, 72)
      .padding(.bottom, 72)
    }
  }

  private func daySection(_ day: TimelineDay) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(Self.headerText(for: day))
        .font(.system(size: 22, weight: .semibold))
        .foregroundStyle(MapleTVTheme.textPrimary)
        .accessibilityAddTraits(.isHeader)

      LazyVGrid(columns: Self.columns, alignment: .leading, spacing: 32) {
        ForEach(day.assets) { asset in
          TimelineCell(
            asset: asset,
            server: session.server,
            thumbClient: session.thumbClient,
            thumbCache: session.thumbCache,
            identifier: "timeline-cell-\(asset.id)",
            onSelect: { selectedAsset = asset }
          )
          .focused($focusedCellID, equals: asset.id)
        }
      }
    }
  }

  private static func headerText(for day: TimelineDay) -> String {
    let dateText = day.date.formatted(.dateTime.weekday(.wide).month(.wide).day().year())
    guard let place = placeText(day.place) else { return dateText }
    return "\(dateText) — \(place)"
  }

  /// Concise place string for a day-section header: locality + (region
  /// or country code) from the geocode rollups, falling back to the
  /// server's own `display_name` when rollups aren't present (Global
  /// Constraint: day-section headers show the date and the geocoded
  /// `place` when present).
  private static func placeText(_ place: SearchAssetPlace?) -> String? {
    guard let place else { return nil }
    if let rollups = place.rollups {
      let parts = [rollups.locality, rollups.region ?? rollups.country_code]
        .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
      if !parts.isEmpty { return parts.joined(separator: ", ") }
    }
    // An empty/whitespace-only `display_name` is "no usable place," same
    // as `nil` — otherwise the header renders a trailing "— " artifact.
    let displayName = place.display_name?.trimmingCharacters(in: .whitespaces)
    return (displayName?.isEmpty == false) ? displayName : nil
  }
}
