// CloudTimelineView.swift
//
// Native port of the web app's timeline-view.component.ts. Renders a
// LazyVStack of month sections; each section's onAppear triggers
// CloudTimelineViewModel.loadPage. Asset cells fetch + cache thumbnails
// asynchronously via CloudThumbCache + CloudThumbClient.
//
// Cell rendering (square thumb + rounded corners + fill/fit content
// mode) is shared with BrowseGrid via the `ThumbnailImage` view. The
// only Timeline-specific bits are: month-section headers, rating
// overlay, and the cloud-thumb load path. Caption is suppressed
// because the timeline is dense and filename labels would crowd it.

import SwiftUI
import MapleCore
import OSLog
import Photos
import ImageIO
import UniformTypeIdentifiers
#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

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
            hasLoaded: vm.pagesByBucket[bucketKey] != nil,
            thumbClient: thumbClient,
            thumbCache: thumbCache,
            // Same port-aware key the buckets/pages caches use, so all
            // three on-disk caches namespace per-server identically.
            host: vm.server.cacheHostKey,
            displayMode: displayMode,
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
  let thumbClient: CloudThumbClient
  let thumbCache: CloudThumbCache
  let host: String
  let displayMode: GridDisplayMode
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
        LazyVGrid(
          columns: Array(repeating: GridItem(.flexible(), spacing: 6),
                         count: CloudTimelineViewVM.columnCount),
          spacing: 6
        ) {
          // Prefer the merged view when the VM produced one. Otherwise
          // fall back to the raw cloud-only cells.
          if let merged = mergedCells {
            // abs_path → SearchAsset map so each merged cell can find its
            // cloud-side asset by id (cell.id is "fs:<abs_path>"). Built
            // once per section render rather than per-cell, via the pure
            // VM helper.
            let absPathToAsset = CloudTimelineViewVM.absPathMap(from: assets)
            ForEach(merged, id: \.renderID) { cell in
              CloudTimelineMergedCell(
                cell: cell,
                thumbClient: thumbClient,
                thumbCache: thumbCache,
                host: host,
                displayMode: displayMode,
                // Cloud-side cells route through the SearchAsset map so the
                // editor opens via CloudSource. `.localOnly` cells aren't on
                // the server yet — open the PhotoKit asset directly via the
                // local identifier carried on the local ImageRef. The
                // routing decision is encoded as a pure switch in the VM.
                onSelect: {
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
                }
              )
            }
          } else {
            ForEach(assets, id: \.id) { asset in
              CloudTimelineCell(
                asset: asset,
                thumbClient: thumbClient,
                thumbCache: thumbCache,
                host: host,
                displayMode: displayMode,
                onSelect: { onSelectAsset(asset) }
              )
            }
          }
        }
      }
    }
  }

  /// Human-readable section title — delegates to the pure VM helper so
  /// the date-formatter cache lives in one place and the format is
  /// unit-testable in isolation.
  private var monthLabel: String {
    CloudTimelineViewVM.monthLabel(year: year, month: month)
  }
}

// MARK: - Cell

struct CloudTimelineCell: View {
  let asset: SearchAsset
  let thumbClient: CloudThumbClient
  let thumbCache: CloudThumbCache
  let host: String
  let displayMode: GridDisplayMode
  let onSelect: () -> Void

  /// Raw JPEG bytes once the cloud thumb has loaded. Drives
  /// `ThumbnailImage` directly — same data shape BrowseGrid uses.
  @State private var thumbData: Data?

  var body: some View {
    ThumbnailImage(jpegData: thumbData, displayMode: displayMode)
      .overlay(alignment: .topLeading) {
        if let rating = asset.rating, rating > 0 {
          HStack(spacing: 1) {
            ForEach(0..<rating, id: \.self) { _ in
              Image(systemName: "star.fill").font(.caption2)
            }
          }
          .foregroundStyle(.yellow)
          .padding(4)
        }
      }
      // Tap target is the whole cell rectangle. `Button(.plain)` inside a
      // LazyVGrid was registering inconsistently on macOS — the cell's
      // clipShape narrowed the active hit area to the rounded rect and
      // the corners (and sometimes more) silently swallowed clicks. The
      // .contentShape + .onTapGesture pair is the pattern BrowseGrid uses
      // and it gives a reliable hit area across macOS/iPad/iPhone.
      .contentShape(Rectangle())
      .onTapGesture { onSelect() }
      // `.task(id:)` instead of `.onAppear` because LazyVGrid doesn't
      // reliably fire `.onAppear` for cells created NEW when the parent's
      // body re-evaluates (e.g. skeleton placeholders → real cells when
      // a page finishes loading) — they're already in the lazy grid's
      // visible window so the appear callback never gets queued. `.task`
      // runs on first attachment regardless of layout state, restarts
      // when `asset.id` changes, and auto-cancels on disappear.
      .task(id: asset.id) {
      timelineLog.debug("cell task fire id=\(asset.id, privacy: .public) abs=\(asset.abs_path, privacy: .public)")
      let bytes = await Self.fetchThumbBytes(
        host: host,
        absPath: asset.abs_path,
        cache: thumbCache,
        client: thumbClient
      )
      guard !Task.isCancelled else {
        timelineLog.debug("cell task cancelled id=\(asset.id, privacy: .public)")
        return
      }
      timelineLog.debug("cell task got bytes id=\(asset.id, privacy: .public) size=\(bytes?.count ?? -1, privacy: .public)")
      withAnimation(.easeInOut(duration: 0.18)) {
        thumbData = bytes
      }
    }
  }

  fileprivate static func fetchThumbBytes(
    host: String,
    absPath: String,
    cache: CloudThumbCache,
    client: CloudThumbClient
  ) async -> Data? {
    if let cached = await cache.get(host: host, absPath: absPath) {
      return cached
    }
    do {
      let bytes = try await client.thumb(absPath: absPath)
      await cache.put(host: host, absPath: absPath, bytes)
      return bytes
    } catch {
      return nil
    }
  }
}

// MARK: - CloudTimelineMergedCell

/// Grid cell for a merged Photos+Cloud timeline entry. Shows a thumbnail
/// and a sync-status badge (.synced / .localOnly / .cloudOnly).
///
/// Thumb priority mirrors BrowseGrid.MergedCellView:
///   .synced / .localOnly — PhotoKit fast path via PHImageManager
///   .cloudOnly           — cloud thumb via CloudThumbClient
///
/// Tapping currently no-ops for .localOnly cells (no SearchAsset to open).
/// .cloudOnly / .synced open via the parent's `onSelect` callback which
/// the caller wires to `onSelectAsset` in AppShell.
struct CloudTimelineMergedCell: View {
  let cell: MergedTimelineCell
  let thumbClient: CloudThumbClient
  let thumbCache: CloudThumbCache
  let host: String
  let displayMode: GridDisplayMode
  let onSelect: () -> Void

  @State private var thumbData: Data?
  @State private var loadTask: Task<Void, Never>?

  var body: some View {
    ThumbnailImage(jpegData: thumbData, displayMode: displayMode)
      .overlay(alignment: .bottomTrailing) {
        badgeView.padding(4)
      }
      // See CloudTimelineCell — same reason. Reliable LazyVGrid tap target.
      .contentShape(Rectangle())
      .onTapGesture { onSelect() }
      .task(id: MergedTimelineSource.renderID(cell)) {
        await startLoad()
      }
  }

  @ViewBuilder
  private var badgeView: some View {
    switch cell {
    case .synced:
      Image(systemName: "checkmark.icloud.fill")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(.white)
        .shadow(radius: 1)
    case .cloudOnly:
      Image(systemName: "icloud.fill")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(.white)
        .shadow(radius: 1)
    case .localOnly:
      // Pending-upload state is implied (PhotoKit photo in the cloud-library
      // view = enrolled in backup, not yet uploaded). Showing
      // `icloud.and.arrow.up` on every cell during initial backup made the
      // grid feel cluttered — the BackupStatusPanel surfaces the real
      // upload progress. Synced/cloud-only stay visible because they're
      // genuinely informative.
      EmptyView()
    }
  }

  private func startLoad() async {
    switch cell {
    case .synced(let local, _), .localOnly(let local):
      thumbData = await Self.fetchPhotoKitThumb(localID: local.id)
    case .cloudOnly(let cloud):
      // Extract the abs_path from the "fs:<path>" id shape via the pure
      // VM helper.
      let absPath = CloudTimelineViewVM.absPath(fromCloudID: cloud.id)
      thumbData = await CloudTimelineCell.fetchThumbBytes(
        host: host, absPath: absPath, cache: thumbCache, client: thumbClient)
    }
  }

  private static func fetchPhotoKitThumb(localID: String) async -> Data? {
    // PHImageManager fast path — Photos' preview cache makes this ~5–50 ms.
    guard let phAsset = PHAsset
      .fetchAssets(withLocalIdentifiers: [localID], options: nil)
      .firstObject else { return nil }

    let target = ThumbnailDiskCache.defaultThumbSize
    return await withCheckedContinuation { cont in
      let options = PHImageRequestOptions()
      options.deliveryMode = .opportunistic
      options.resizeMode = .fast
      options.isNetworkAccessAllowed = true
      options.isSynchronous = false
      final class Latch: @unchecked Sendable {
        let lock = NSLock(); var fired = false
        func tryFire() -> Bool {
          lock.lock(); defer { lock.unlock() }
          if fired { return false }; fired = true; return true
        }
      }
      let latch = Latch()
      PHImageManager.default().requestImage(
        for: phAsset, targetSize: target, contentMode: .aspectFill, options: options
      ) { image, info in
        if (info?[PHImageResultIsDegradedKey] as? Bool) == true { return }
        guard latch.tryFire() else { return }
        guard let image else { cont.resume(returning: nil); return }
        #if canImport(AppKit)
        var rect = CGRect(origin: .zero, size: image.size)
        guard let cg = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) else {
          cont.resume(returning: nil); return
        }
        #elseif canImport(UIKit)
        guard let cg = image.cgImage else { cont.resume(returning: nil); return }
        #endif
        let mutableData = NSMutableData()
        let type = UTType.jpeg.identifier as CFString
        guard let dest = CGImageDestinationCreateWithData(mutableData, type, 1, nil) else {
          cont.resume(returning: nil); return
        }
        CGImageDestinationAddImage(dest, cg, [kCGImageDestinationLossyCompressionQuality: ThumbnailDiskCache.jpegQuality] as CFDictionary)
        cont.resume(returning: CGImageDestinationFinalize(dest) ? (mutableData as Data) : nil)
      }
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
