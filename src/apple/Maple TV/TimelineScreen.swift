// src/apple/Maple TV/TimelineScreen.swift
import MapleCloudKit
import SwiftUI

/// The Timeline: day-grouped, focus-navigable photo grid. Milestone D
/// presents this as the connected root (the floating Timeline/Light-Table
/// tab bar from the design ships in F, once Light Table exists — Global
/// Constraint, #2102).
///
/// Owns a `TVTimelineViewModel` scoped to `libraryID`; `onForgotten`
/// threads milestone C's pairing-reversal path through `TimelineTopBar`.
struct TimelineScreen: View {
  let session: TVCloudSession
  let libraryID: String
  let libraryName: String
  let onForgotten: () -> Void

  @State private var viewModel: TVTimelineViewModel
  /// D6 (#2102) presents the full-screen viewer (current result set +
  /// selected index) when this is non-nil. D5's job is only to give
  /// `TimelineCell` a working selection seam — the viewer itself isn't
  /// built yet, so a selection is currently a no-op beyond recording it.
  @State private var selectedAsset: SearchAsset?

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
  }

  private var serverDisplayName: String {
    CloudServerRegistry.shared.displayName(for: session.server)
      ?? CloudHost.parse(session.server.absoluteString)?.displayHost
      ?? session.server.host
      ?? session.server.absoluteString
  }

  @ViewBuilder
  private var content: some View {
    if viewModel.isLoading, viewModel.days.isEmpty {
      loadingView
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
