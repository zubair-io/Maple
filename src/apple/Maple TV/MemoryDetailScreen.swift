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
// This screen is handed its assets rather than fetching them: `MemoriesScreen`
// already loads them to decide whether the memory is worth opening at all
// (an empty one opens nothing), so re-fetching here would be a second round
// trip for bytes already in hand.

import MapleCloudKit
import SwiftUI

struct MemoryDetailScreen: View {
  let collection: GeneratedSearchCard
  let assets: [SearchAsset]
  let session: TVCloudSession

  /// Presents `PhotoViewerScreen` at the chosen photo when non-nil.
  @State private var selectedAsset: SearchAsset?
  /// Which cell holds tvOS remote focus. Written back by the viewer's
  /// `onDismiss` so Menu returns to the grid at the photo that was on screen,
  /// not the one that opened it — the same contract `TimelineScreen` has.
  @FocusState private var focusedCellID: String?
  @Environment(\.dismiss) private var dismiss

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
      let startIndex = assets.firstIndex(where: { $0.id == asset.id }) ?? 0
      PhotoViewerScreen(
        // Falls back to a single-asset list only in the practically
        // unreachable case where `asset` isn't in `assets` at cover-render
        // time — mirrors `TimelineScreen`'s same fallback.
        assets: assets.isEmpty ? [asset] : assets,
        startIndex: startIndex,
        session: session,
        onDismiss: { viewedAsset in focusedCellID = viewedAsset.id }
      )
    }
  }

  /// The memory's own subtitle line if the server gave it one, otherwise the
  /// photo count — the top bar should never render a blank second line.
  private var subtitle: String {
    let described = collection.subtitle?.trimmingCharacters(in: .whitespaces)
    if let described, !described.isEmpty { return described }
    return assets.count == 1 ? "1 photo" : "\(assets.count) photos"
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
        LazyVGrid(columns: layout.gridItems, alignment: .center, spacing: Self.rowSpacing) {
          // A memory is a fixed set the server already returned in full —
          // there is no paging here, so unlike the Timeline this can key on
          // the asset's own id rather than its index.
          ForEach(assets) { asset in
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
          }
        }
        .padding(.horizontal, Self.horizontalInset)
        // Room for the focused cell's 1.09 scale to grow into at the top row
        // rather than clipping against the scroll view's edge.
        .padding(.top, 24)
        .padding(.bottom, 72)
      }
    }
  }
}
