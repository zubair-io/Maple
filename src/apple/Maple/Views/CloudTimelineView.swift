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

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 24) {
        if vm.isLoadingBuckets && vm.buckets.isEmpty {
          ProgressView().padding(40)
        }
        ForEach(vm.buckets, id: \.bucketKey) { bucket in
          CloudTimelineMonthSection(
            year: bucket.year,
            month: bucket.month,
            count: bucket.count,
            assets: vm.pagesByBucket[
              CloudTimelineViewModel.BucketKey(year: bucket.year, month: bucket.month)
            ] ?? [],
            thumbClient: thumbClient,
            thumbCache: thumbCache,
            host: vm.server.host ?? "",
            displayMode: displayMode,
            onSelectAsset: onSelectAsset
          )
          // .task(id:) instead of .onAppear so the page-load fires
          // reliably for newly-rendered sections (LazyVStack is fussy
          // with onAppear in the same way LazyVGrid is — see the cell
          // comment below).
          .task(id: bucket.bucketKey) {
            timelineLog.debug("section task fire \(bucket.bucketKey, privacy: .public) count=\(bucket.count, privacy: .public)")
            await vm.loadPage(year: bucket.year, month: bucket.month)
            timelineLog.debug("section task done \(bucket.bucketKey, privacy: .public) assetsLoaded=\(vm.pagesByBucket[CloudTimelineViewModel.BucketKey(year: bucket.year, month: bucket.month)]?.count ?? -1, privacy: .public)")
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
  /// Stable identity for SwiftUI ForEach.
  fileprivate var bucketKey: String { "\(year)-\(month)" }
}

// MARK: - MonthSection

struct CloudTimelineMonthSection: View {
  let year: Int
  let month: Int
  let count: Int
  let assets: [SearchAsset]
  let thumbClient: CloudThumbClient
  let thumbCache: CloudThumbCache
  let host: String
  let displayMode: GridDisplayMode
  let onSelectAsset: (SearchAsset) -> Void

  private static let columnCount = 4

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(monthLabel).font(.title3.bold())
        Text("\(count)")
          .font(.callout.monospacedDigit())
          .foregroundStyle(.secondary)
        if assets.isEmpty {
          // Inline progress while the page is fetching. Replaces the
          // previous 16-skeleton-placeholder grid which appeared to
          // confuse LazyVGrid's identity tracking and prevented real
          // cells' .task from firing once the page resolved.
          ProgressView()
            .scaleEffect(0.7)
            .padding(.leading, 4)
        }
        Spacer()
      }
      if !assets.isEmpty {
        LazyVGrid(
          columns: Array(repeating: GridItem(.flexible(), spacing: 6),
                         count: Self.columnCount),
          spacing: 6
        ) {
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

  private var monthLabel: String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "MMMM yyyy"
    var c = DateComponents(); c.year = year; c.month = month; c.day = 1
    let cal = Calendar(identifier: .gregorian)
    if let d = cal.date(from: c) { return f.string(from: d) }
    return "\(year)-\(String(format: "%02d", month))"
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
    Button(action: onSelect) {
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
    }
    .buttonStyle(.plain)
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

  private static func fetchThumbBytes(
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
