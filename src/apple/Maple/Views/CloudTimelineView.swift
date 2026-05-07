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
#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

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
          .onAppear {
            Task { await vm.loadPage(year: bucket.year, month: bucket.month) }
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
      }
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
        // Skeleton cells while the page is still loading. We show as many
        // placeholders as the bucket count so the layout doesn't jump.
        if assets.isEmpty {
          ForEach(0..<min(count, 16), id: \.self) { _ in
            ThumbnailImage(jpegData: nil, displayMode: displayMode)
              .opacity(0.5)
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
  @State private var loadTask: Task<Void, Never>?

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
    .onAppear { startLoad() }
    .onDisappear {
      loadTask?.cancel()
      loadTask = nil
    }
  }

  private func startLoad() {
    guard thumbData == nil, loadTask == nil else { return }
    let captured = (asset, thumbCache, thumbClient, host)
    loadTask = Task { @MainActor in
      let bytes = await Self.fetchThumbBytes(
        host: captured.3,
        absPath: captured.0.abs_path,
        cache: captured.1,
        client: captured.2
      )
      guard !Task.isCancelled else { return }
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
