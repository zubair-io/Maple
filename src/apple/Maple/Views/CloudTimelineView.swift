// CloudTimelineView.swift
//
// Native port of the web app's timeline-view.component.ts. Renders a
// LazyVStack of month sections; each section's onAppear triggers
// CloudTimelineViewModel.loadPage. Asset cells fetch + cache thumbnails
// asynchronously via CloudThumbCache + CloudThumbClient.

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
            onSelect: { onSelectAsset(asset) }
          )
        }
        // Skeleton cells while the page is still loading. We show as many
        // placeholders as the bucket count so the layout doesn't jump.
        if assets.isEmpty {
          ForEach(0..<min(count, 16), id: \.self) { _ in
            Color.gray.opacity(0.10)
              .aspectRatio(1, contentMode: .fill)
              .clipShape(RoundedRectangle(cornerRadius: 4))
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
  let onSelect: () -> Void

  @State private var thumb: PlatformImage?

  var body: some View {
    Button(action: onSelect) {
      Group {
        if let thumb {
          Image(platformImage: thumb)
            .resizable()
            .aspectRatio(contentMode: .fill)
        } else {
          Color.gray.opacity(0.15)
        }
      }
      .aspectRatio(1, contentMode: .fill)
      .clipShape(RoundedRectangle(cornerRadius: 4))
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
    .task { await loadThumb() }
  }

  private func loadThumb() async {
    if let cached = await thumbCache.get(host: host, absPath: asset.abs_path) {
      thumb = PlatformImage(data: cached)
      return
    }
    do {
      let bytes = try await thumbClient.thumb(absPath: asset.abs_path)
      await thumbCache.put(host: host, absPath: asset.abs_path, bytes)
      thumb = PlatformImage(data: bytes)
    } catch {
      // Leave the placeholder up — the cell stays clickable; failed loads
      // surface naturally next time the cell appears.
    }
  }
}

// MARK: - Cross-platform image bridge

#if canImport(AppKit)
typealias PlatformImage = NSImage
extension Image {
  init(platformImage: NSImage) { self.init(nsImage: platformImage) }
}
#elseif canImport(UIKit)
typealias PlatformImage = UIImage
extension Image {
  init(platformImage: UIImage) { self.init(uiImage: platformImage) }
}
#endif
