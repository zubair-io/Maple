// src/apple/Maple TV/MemoriesScreen.swift
//
// Memories: the daily generated collections the server's generated-search
// worker invents ("Spooky Nights", "Seven Summers of Lake George"), as a
// screen of their own reached from the Menu.
//
// This used to be a horizontal "Rediscover" shelf pinned above the Timeline
// grid. It isn't any more: on a television the shelf stole the top of the
// browse screen and pushed the actual photo wall down, and it put a second
// focus region in the way of the one thing the Timeline is for. Browse is now
// only the photo grid; memories get the whole screen and can breathe.
//
// Selecting a memory opens that memory's own grid (`MemoryDetailScreen`),
// and a photo in that grid opens the full-screen viewer. Selecting used to
// drop straight into the viewer at the first photo, which gave no sense of
// what was in the set and no way to reach a particular photo except by
// stepping past everything before it.

import MapleCloudKit
import SwiftUI

struct MemoriesScreen: View {
  let session: TVCloudSession
  let libraryID: String

  @State private var viewModel: TVGeneratedSearchViewModel
  /// The memory whose grid is open, with the photos already fetched for it.
  /// Wrapped because `fullScreenCover(item:)` needs an `Identifiable`.
  @State private var openMemory: OpenMemory?

  /// The memory whose photos are being fetched right now, if any. A memory's
  /// assets are a round trip away, so without this the card would sit there
  /// looking inert between the click and the grid appearing.
  @State private var openingCollectionID: String?

  private struct OpenMemory: Identifiable {
    var id: String { collection.id }
    let collection: GeneratedSearchCard
    let firstPage: [SearchAsset]
    /// The collection's full size, so the grid knows how much is still to
    /// come — `firstPage` is one page of it, not the whole thing.
    let total: Int
  }

  init(session: TVCloudSession, libraryID: String) {
    self.session = session
    self.libraryID = libraryID
    _viewModel = State(initialValue: TVGeneratedSearchViewModel(
      libraryID: libraryID,
      client: session.generatedSearchClient
    ))
  }

  private static let cardSpacing: CGFloat = 40
  private static let rowSpacing: CGFloat = 48
  private static let horizontalInset: CGFloat = 72

  var body: some View {
    ZStack {
      MapleTVTheme.background.ignoresSafeArea()
      VStack(alignment: .leading, spacing: 0) {
        TimelineTopBar(title: "Memories", subtitle: subtitle)
        content
      }
    }
    // A plain (no-`id:`) `.task` is correct here only because the caller
    // gives this screen a per-library SwiftUI identity, so a library switch
    // rebuilds the view (and its `@State` viewModel) rather than re-running
    // `load()` against a viewModel still bound to the old library.
    .task { await viewModel.load() }
    .fullScreenCover(item: $openMemory) { open in
      MemoryDetailScreen(
        collection: open.collection,
        firstPage: open.firstPage,
        total: open.total,
        session: session
      )
    }
  }

  private var subtitle: String? {
    let count = viewModel.collections.count
    guard count > 0 else { return nil }
    return count == 1 ? "1 collection" : "\(count) collections"
  }

  // MARK: - Content states

  @ViewBuilder
  private var content: some View {
    // Order matters: loading first, then a failed load with nothing to show,
    // then the genuinely-empty steady state, then the grid.
    if viewModel.isLoading, viewModel.collections.isEmpty {
      loadingView
    } else if let error = viewModel.loadError, viewModel.collections.isEmpty {
      errorView(error)
    } else if viewModel.collections.isEmpty {
      emptyView
    } else {
      grid
    }
  }

  private var loadingView: some View {
    ProgressView("Loading memories…")
      .tint(MapleTVTheme.textPrimary)
      .foregroundStyle(MapleTVTheme.textPrimary)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .accessibilityLabel("Loading memories")
  }

  private func errorView(_ error: Error) -> some View {
    VStack(spacing: 16) {
      Image(systemName: "wifi.exclamationmark")
        .font(.system(size: 56))
        .foregroundStyle(MapleTVTheme.primary)
        .accessibilityHidden(true)
      Text("Couldn't load memories")
        .font(.system(size: 28, weight: .semibold))
        .foregroundStyle(MapleTVTheme.textPrimary)
      Text(error.localizedDescription)
        .font(.system(size: 20))
        .foregroundStyle(MapleTVTheme.textMuted)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 560)
      Button("Retry") { Task { await viewModel.load() } }
        .accessibilityLabel("Retry loading memories")
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var emptyView: some View {
    VStack(spacing: 16) {
      Image(systemName: "sparkles.rectangle.stack")
        .font(.system(size: 56))
        .foregroundStyle(MapleTVTheme.textMuted)
        .accessibilityHidden(true)
      Text("No memories yet")
        .font(.system(size: 28, weight: .semibold))
        .foregroundStyle(MapleTVTheme.textPrimary)
      Text("Maple builds these from your library each day.")
        .font(.system(size: 20))
        .foregroundStyle(MapleTVTheme.textMuted)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("No memories yet")
  }

  /// The wall of memories. Column count and card width both come from the
  /// real container width via `TVGridLayout`, so the grid is centred with
  /// equal margins and uniform gaps at any screen size.
  private var grid: some View {
    GeometryReader { proxy in
      let layout = TVGridLayout(
        containerWidth: proxy.size.width,
        targetCellWidth: MemoryCard.targetWidth,
        spacing: Self.cardSpacing,
        horizontalInset: Self.horizontalInset
      )
      ScrollView {
        LazyVGrid(columns: layout.gridItems, alignment: .center, spacing: Self.rowSpacing) {
          ForEach(viewModel.collections) { collection in
            MemoryCard(
              collection: collection,
              cover: viewModel.covers[collection.id],
              session: session,
              width: layout.cellWidth,
              isOpening: openingCollectionID == collection.id
            ) {
              open(collection)
            }
          }
        }
        .padding(.horizontal, Self.horizontalInset)
        // Room for the card focus effect to grow into at the top row rather
        // than clipping against the scroll view's edge.
        .padding(.top, 24)
        .padding(.bottom, 72)
      }
    }
  }

  private func open(_ collection: GeneratedSearchCard) {
    guard openingCollectionID == nil else { return }
    openingCollectionID = collection.id
    Task {
      let page = await viewModel.firstPage(of: collection)
      openingCollectionID = nil
      // Don't open an empty grid — a memory whose photos failed to load
      // should do nothing rather than show a blank screen.
      if !page.results.isEmpty {
        openMemory = OpenMemory(
          collection: collection,
          firstPage: page.results,
          total: page.total
        )
      }
    }
  }
}

/// One memory: its cover photo with the title and photo count burned into a
/// gradient along the bottom edge.
private struct MemoryCard: View {
  let collection: GeneratedSearchCard
  let cover: SearchAsset?
  let session: TVCloudSession
  /// Derived from the real screen width by `TVGridLayout`; `targetWidth` is
  /// the size the column count is chosen around.
  let width: CGFloat
  /// True while this memory's photos are being fetched — the card dims and
  /// shows a spinner so the click has a visible consequence.
  let isOpening: Bool
  let onSelect: () -> Void

  /// Chosen so a 1080p television lands on four cards per row (the derived
  /// width comes out a little wider than this) rather than three very large
  /// ones — see `TVGridLayout`.
  static let targetWidth: CGFloat = 340
  /// Covers are 16:9 — a television's own shape, so a landscape thumb fills
  /// the card without letterboxing.
  private var height: CGFloat { (width * 9 / 16).rounded() }

  var body: some View {
    Button(action: onSelect) {
      ZStack(alignment: .bottomLeading) {
        coverImage
        caption
        if isOpening {
          ZStack {
            Color.black.opacity(0.5)
            ProgressView().tint(.white)
          }
          .transition(.opacity)
        }
      }
      .frame(width: width, height: height)
      .clipShape(RoundedRectangle(cornerRadius: 12))
      .animation(.easeOut(duration: 0.15), value: isOpening)
    }
    .buttonStyle(.card)
    .accessibilityIdentifier("memory-card-\(collection.id)")
    .accessibilityLabel("\(collection.title), \(collection.result_count) photos")
    .accessibilityValue(isOpening ? "Opening" : "")
  }

  @ViewBuilder
  private var coverImage: some View {
    if let cover {
      TVRemoteImage(
        server: session.server,
        absPath: cover.abs_path,
        kind: .thumb,
        thumbClient: session.thumbClient,
        thumbCache: session.thumbCache,
        contentMode: .fill,
        accessibilityLabel: collection.title
      )
      .frame(width: width, height: height)
    } else {
      // No cover yet (the run stored none, or the thumb is still building).
      LinearGradient(
        colors: [Color(white: 0.22), Color(white: 0.10)],
        startPoint: .top,
        endPoint: .bottom
      )
    }
  }

  private var caption: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(collection.title)
        .font(.headline)
        .lineLimit(1)
      Text("\(collection.result_count) photos")
        .font(.caption)
        .opacity(0.8)
    }
    .foregroundStyle(.white)
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      LinearGradient(
        colors: [.black.opacity(0.0), .black.opacity(0.8)],
        startPoint: .top,
        endPoint: .bottom
      )
    )
  }
}
