// src/apple/Maple TV/MemoryDetailScreen.swift
//
// One memory, opened from the Memories wall: its photos as a grid, and a
// grid cell opens the full-screen viewer at that photo.
//
// Picking a memory used to jump straight into the viewer at index 0, which
// gave the viewer no context and no way to reach a specific photo except by
// stepping through everything in front of it. A memory is a set, so it gets
// the same shape every other set in the app has — a wall you can look over
// first, then a photo.
//
// The first page is handed in rather than fetched: `MemoriesScreen` already
// loads it to decide whether the memory is worth opening at all (an empty one
// opens nothing), so re-fetching page 0 here would be a second round trip for
// rows already in hand. Everything after that is paged in as the grid scrolls
// — a memory is routinely larger than one response.

import MapleCloudKit
import SwiftUI

struct MemoryDetailScreen: View {
  let collection: GeneratedSearchCard
  let session: TVCloudSession

  @State private var viewModel: TVMemoryAssetsViewModel

  /// Presents `PhotoViewerScreen` at the chosen photo when non-nil.
  @State private var selectedAsset: SearchAsset?
  /// Which cell holds tvOS remote focus. Written back by the viewer's
  /// `onDismiss` so Menu returns to the grid at the photo that was on screen,
  /// not the one that opened it — the same contract `TimelineScreen` has.
  @FocusState private var focusedCellID: String?
  @Environment(\.dismiss) private var dismiss

  init(collection: GeneratedSearchCard, firstPage: [SearchAsset], total: Int, session: TVCloudSession) {
    self.collection = collection
    self.session = session
    _viewModel = State(initialValue: TVMemoryAssetsViewModel(
      collectionID: collection.id,
      firstPage: firstPage,
      total: total,
      client: session.generatedSearchClient
    ))
  }

  /// How many trailing cells from the end of the loaded set trigger the next
  /// page — wide enough that paging starts before focus reaches the last
  /// loaded cell, matching `TimelineScreen`.
  private static let pageAheadThreshold = 24

  private static let cellSpacing: CGFloat = 32
  private static let rowSpacing: CGFloat = 40
  private static let horizontalInset: CGFloat = 72

  var body: some View {
    ZStack {
      MapleTVTheme.background.ignoresSafeArea()
      VStack(alignment: .leading, spacing: 0) {
        TimelineTopBar(title: collection.title, subtitle: subtitle)
        grid
      }
    }
    .onExitCommand { dismiss() }
    .fullScreenCover(item: $selectedAsset) { asset in
      let loaded = viewModel.assets
      let startIndex = loaded.firstIndex(where: { $0.id == asset.id }) ?? 0
      PhotoViewerScreen(
        // Falls back to a single-asset list only in the practically
        // unreachable case where `asset` isn't in the loaded set at
        // cover-render time — mirrors `TimelineScreen`'s same fallback.
        assets: loaded.isEmpty ? [asset] : loaded,
        startIndex: startIndex,
        session: session,
        onDismiss: { viewedAsset in focusedCellID = viewedAsset.id }
      )
    }
  }

  /// The memory's own subtitle if the server gave it one, otherwise the photo
  /// count. The count is the COLLECTION's, not the loaded page's — the grid
  /// fills in behind it as you scroll, and a header that counted only what had
  /// arrived would tick upward while you looked at it.
  private var subtitle: String {
    let described = collection.subtitle?.trimmingCharacters(in: .whitespaces)
    if let described, !described.isEmpty { return described }
    return collection.result_count == 1 ? "1 photo" : "\(collection.result_count) photos"
  }

  /// Same wall shape as the Timeline: `TVGridLayout` derives the column count
  /// and cell size from the real container width, so the grid is centred with
  /// equal margins and uniform gaps.
  private var grid: some View {
    GeometryReader { proxy in
      let layout = TVGridLayout(
        containerWidth: proxy.size.width,
        targetCellWidth: TimelineCell.targetSize,
        spacing: Self.cellSpacing,
        horizontalInset: Self.horizontalInset
      )
      ScrollView {
        VStack(spacing: 0) {
          LazyVGrid(columns: layout.gridItems, alignment: .center, spacing: Self.rowSpacing) {
            let assets = viewModel.assets
            // Index-as-identity, matching the Timeline: a memory's pages only
            // ever append, so no cell's identity shifts under it, and focus
            // keys on `asset.id` below regardless.
            ForEach(assets.indices, id: \.self) { index in
              let asset = assets[index]
              TimelineCell(
                asset: asset,
                server: session.server,
                thumbClient: session.thumbClient,
                thumbCache: session.thumbCache,
                identifier: "memory-cell-\(asset.id)",
                size: layout.cellWidth,
                onSelect: { selectedAsset = asset }
              )
              .focused($focusedCellID, equals: asset.id)
              .onAppear {
                guard viewModel.canLoadMore, index >= assets.count - Self.pageAheadThreshold else { return }
                Task { await viewModel.loadMore() }
              }
            }
          }
          .padding(.horizontal, Self.horizontalInset)

          if viewModel.stoppedShort {
            Text("Showing \(viewModel.assets.count) of \(viewModel.collectionTotal) photos")
              .font(.system(size: 18))
              .foregroundStyle(MapleTVTheme.textMuted)
              .frame(maxWidth: .infinity)
              .padding(.top, 36)
          }
        }
        // Room for the focused cell's 1.09 scale to grow into at the top row
        // rather than clipping against the scroll view's edge.
        .padding(.top, 24)
        .padding(.bottom, 72)
      }
    }
  }
}
