// CloudTimelineView.swift
//
// Native port of the web app's timeline-view.component.ts. Renders a
// LazyVStack of month sections; each section's .task(id:) triggers
// CloudTimelineViewModel.loadPage. Cells are rendered via the shared
// PhotoGrid / PhotoThumbnailCell / ThumbnailProvider components.
//
// M2 (#1490): migrated onto shared grid components. The per-section
// LazyVGrid + inline CloudTimelineCell / CloudTimelineMergedCell are
// replaced by PhotoGrid using PhotoGridItem(cloud:) / PhotoGridItem(merged:).
// CloudTimelineMonthSection retains its header + spinner/no-results logic;
// the grid body is now a PhotoGrid. CloudTimelineCell and
// CloudTimelineMergedCell are deleted — ThumbnailProvider absorbs their
// load paths.

import SwiftUI
import MapleCore
import OSLog

private let timelineLog = Logger(subsystem: "app.justmaple.aperture", category: "CloudTimeline")

struct CloudTimelineView: View {
  @State var vm: CloudTimelineViewModel
  let thumbClient: CloudThumbClient
  let thumbCache: CloudThumbCache
  /// Shared with BrowseGrid via the toolbar's fill/fit toggle. Drives
  /// `ThumbnailImage.displayMode` for every cell — same toggle, same
  /// behavior across both grids.
  let displayMode: GridDisplayMode
  let onSelectAsset: (SearchAsset) -> Void
  /// Tap target for `.localOnly` merged cells — these are PhotoKit photos
  /// the backup hasn't uploaded yet, so they have no `SearchAsset` to
  /// route through `onSelectAsset`. AppShell opens them via PhotoKit
  /// using the local identifier carried on the `ImageRef`.
  let onSelectLocalAsset: (ImageRef) -> Void

  /// Shared provider wired to the cloud thumb infrastructure, created once
  /// and reused across all sections so the underlying cache is shared.
  @State private var provider: ThumbnailProvider

  init(
    vm: CloudTimelineViewModel,
    thumbClient: CloudThumbClient,
    thumbCache: CloudThumbCache,
    displayMode: GridDisplayMode,
    onSelectAsset: @escaping (SearchAsset) -> Void,
    onSelectLocalAsset: @escaping (ImageRef) -> Void
  ) {
    self.vm = vm
    self.thumbClient = thumbClient
    self.thumbCache = thumbCache
    self.displayMode = displayMode
    self.onSelectAsset = onSelectAsset
    self.onSelectLocalAsset = onSelectLocalAsset
    self._provider = State(initialValue: ThumbnailProvider(
      thumbClient: thumbClient, thumbCache: thumbCache))
  }

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 24) {
        if vm.isLoadingBuckets && vm.buckets.isEmpty {
          ProgressView().padding(40)
        }
        ForEach(vm.buckets, id: \.bucketKey) { bucket in
          let bucketKey = CloudTimelineViewModel.BucketKey(year: bucket.year, month: bucket.month)
          let sectionTaskID = CloudTimelineViewVM.bucketKey(year: bucket.year, month: bucket.month)
          CloudTimelineMonthSection(
            year: bucket.year,
            month: bucket.month,
            count: bucket.count,
            assets: vm.pagesByBucket[bucketKey] ?? [],
            mergedCells: vm.mergedPagesByBucket[bucketKey],
            // hasLoaded == true once loadPage has resolved at least once
            // for this bucket (whether with N results or 0). Distinguishes
            // "still fetching" from "fetched + server returned empty"
            // — needed because `assets.isEmpty` alone can't tell those
            // apart, and the server has a bug where `buckets` reports a
            // count > 0 but `/search` returns []. Without this, those
            // months would spin forever.
            //
            // Merged cells count as "loaded" too: a PhotoKit-only month (or
            // one whose cloud page is still in flight / offline) renders its
            // local cells from `mergedPagesByBucket` before any cloud page
            // resolves, so we must not show a spinner next to a populated
            // local grid.
            hasLoaded: vm.pagesByBucket[bucketKey] != nil
              || vm.mergedPagesByBucket[bucketKey] != nil,
            host: vm.server.cacheHostKey,
            displayMode: displayMode,
            provider: provider,
            onSelectAsset: onSelectAsset,
            onSelectLocalAsset: onSelectLocalAsset
          )
          // .task(id:) instead of .onAppear so the page-load fires
          // reliably for newly-rendered sections (LazyVStack is fussy
          // with onAppear in the same way LazyVGrid is — see the cell
          // comment below).
          .task(id: sectionTaskID) {
            timelineLog.debug("section task fire \(sectionTaskID, privacy: .public) count=\(bucket.count, privacy: .public)")
            await vm.loadPage(year: bucket.year, month: bucket.month)
            timelineLog.debug("section task done \(sectionTaskID, privacy: .public) assetsLoaded=\(vm.pagesByBucket[bucketKey]?.count ?? -1, privacy: .public)")
          }
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
    }
    .task { await vm.loadBuckets() }
    .refreshable { await vm.loadBuckets() }
  }
}

extension TimelineBucket {
  /// Stable identity for SwiftUI ForEach. Delegates to the pure VM
  /// helper so the same key shape powers both `ForEach(... id:)` and the
  /// section's `.task(id:)`.
  fileprivate var bucketKey: String {
    CloudTimelineViewVM.bucketKey(year: year, month: month)
  }
}

extension MergedTimelineCell {
  /// Stable id for SwiftUI ForEach — delegates to `MergedTimelineSource.renderID`.
  fileprivate var renderID: String { MergedTimelineSource.renderID(self) }
}

// MARK: - MonthSection

struct CloudTimelineMonthSection: View {
  let year: Int
  let month: Int
  let count: Int
  let assets: [SearchAsset]
  /// When non-nil (merge active), the grid renders these merged cells
  /// instead of the raw `assets` list. Each cell carries a sync-status
  /// badge (synced / localOnly / cloudOnly). `nil` when the VM has no
  /// PhotoKitMergeAdapter or the page hasn't loaded yet.
  let mergedCells: [MergedTimelineCell]?
  /// True once loadPage has resolved at least once for this bucket. The
  /// spinner shows ONLY when (loading && results not yet in) — once the
  /// server has answered, the spinner goes away even if the answer was
  /// `results: []`.
  let hasLoaded: Bool
  let host: String
  let displayMode: GridDisplayMode
  let provider: ThumbnailProvider
  let onSelectAsset: (SearchAsset) -> Void
  let onSelectLocalAsset: (ImageRef) -> Void

  /// The content to display is whichever of merged / raw is available.
  /// Delegates to the pure VM helper so the predicate is unit-testable.
  private var hasContent: Bool {
    CloudTimelineViewVM.hasContent(assets: assets, mergedCells: mergedCells)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(monthLabel).font(.title3.bold())
        Text("\(count)")
          .font(.callout.monospacedDigit())
          .foregroundStyle(.secondary)
        if !hasLoaded {
          // Inline spinner while the first page-fetch is in flight.
          // Replaces the previous 16-skeleton-placeholder grid which
          // confused LazyVGrid's identity tracking and prevented real
          // cells' .task from firing once the page resolved.
          ProgressView()
            .controlSize(.small)
            .padding(.leading, 4)
        } else if !hasContent {
          // Server returned 0 results for a bucket whose count > 0
          // (known server-side data inconsistency between
          // /api/search/buckets and /api/search). Surface it instead of
          // spinning forever.
          Text("no results")
            .font(.caption)
            .foregroundStyle(.tertiary)
            .padding(.leading, 4)
        }
        Spacer()
      }
      if hasContent {
        if let merged = mergedCells {
          mergedGrid(cells: merged)
        } else {
          cloudGrid(assets: assets)
        }
      }
    }
  }

  // MARK: - Cloud-only grid (no merge)

  /// Grid for a pure cloud section: maps `SearchAsset`s to
  /// `PhotoGridItem(cloud:host:style:.cloud)` via the shared `PhotoGrid`.
  /// Rating stars appear top-leading (`.cloud` overlay style).
  @ViewBuilder
  private func cloudGrid(assets: [SearchAsset]) -> some View {
    PhotoGrid(
      data: assets,
      columns: .fixed(CloudTimelineViewVM.columnCount, spacing: 6),
      provider: provider,
      displayMode: displayMode,
      onTap: { onSelectAsset($0) },
      makeItem: { asset in
        PhotoGridItem(cloud: asset, host: host, style: .cloud)
      }
    )
  }

  // MARK: - Merged grid (PhotoKit + Cloud)

  /// Grid for a merged section: maps `MergedTimelineCell`s to
  /// `PhotoGridItem(merged:host:sync:style:.desktop)` via the shared `PhotoGrid`.
  /// Tap routing replicates the original `CloudTimelineViewVM.selectionTarget`
  /// logic: `.cloud(asset)` → `onSelectAsset`; `.local(ref)` → `onSelectLocalAsset`;
  /// `.none` → no-op.
  @ViewBuilder
  private func mergedGrid(cells: [MergedTimelineCell]) -> some View {
    // abs_path → SearchAsset map so each merged cell can find its
    // cloud-side asset by id (cell.id is "fs:<abs_path>"). Built
    // once per section render rather than per-cell, via the pure VM helper.
    let absPathToAsset = CloudTimelineViewVM.absPathMap(from: assets)
    PhotoGrid(
      data: cells,
      columns: .fixed(CloudTimelineViewVM.columnCount, spacing: 6),
      provider: provider,
      displayMode: displayMode,
      onTap: { cell in
        // Cloud-side cells route through the SearchAsset map so the
        // editor opens via CloudSource. `.localOnly` cells aren't on
        // the server yet — open the PhotoKit asset directly via the
        // local identifier carried on the local ImageRef. The
        // routing decision is encoded as a pure switch in the VM.
        switch CloudTimelineViewVM.selectionTarget(
          for: cell, absPathMap: absPathToAsset
        ) {
        case .cloud(let asset):
          onSelectAsset(asset)
        case .local(let local):
          onSelectLocalAsset(local)
        case .none:
          break
        }
      },
      makeItem: { cell in
        PhotoGridItem(merged: cell, host: host, sync: syncBadge(for: cell), style: .desktop)
      }
    )
  }

  // MARK: - Helpers

  /// Human-readable section title — delegates to the pure VM helper so
  /// the date-formatter cache lives in one place and the format is
  /// unit-testable in isolation.
  private var monthLabel: String {
    CloudTimelineViewVM.monthLabel(year: year, month: month)
  }

  private func syncBadge(for cell: MergedTimelineCell) -> SyncBadge {
    switch cell {
    case .synced:    return .synced
    case .cloudOnly: return .cloudOnly
    case .localOnly: return .localOnly
    }
  }
}

// MARK: - Previews
//
// Issue #139 — cloud timeline view. Driven by `CloudTimelineViewModel.preview()`
// so we can stage empty / loading / loaded month buckets. Thumb client +
// cache point at preview factories; any HTTP call fails fast and the
// cells render their placeholder squares.

#Preview("Loaded — months") {
    CloudTimelineView(
      vm: CloudTimelineViewModel.preview(.loaded),
      thumbClient: CloudThumbClient.preview(),
      thumbCache: CloudThumbCache.preview(),
      displayMode: .fill,
      onSelectAsset: { _ in },
      onSelectLocalAsset: { _ in }
    )
    .frame(width: 720, height: 540)
}

#Preview("Empty (no months)") {
    CloudTimelineView(
      vm: CloudTimelineViewModel.preview(.empty),
      thumbClient: CloudThumbClient.preview(),
      thumbCache: CloudThumbCache.preview(),
      displayMode: .fill,
      onSelectAsset: { _ in },
      onSelectLocalAsset: { _ in }
    )
    .frame(width: 720, height: 540)
}

#Preview("Loading") {
    CloudTimelineView(
      vm: CloudTimelineViewModel.preview(.loading),
      thumbClient: CloudThumbClient.preview(),
      thumbCache: CloudThumbCache.preview(),
      displayMode: .fill,
      onSelectAsset: { _ in },
      onSelectLocalAsset: { _ in }
    )
    .frame(width: 720, height: 540)
}
