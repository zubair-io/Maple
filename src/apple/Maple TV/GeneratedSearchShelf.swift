// src/apple/Maple TV/GeneratedSearchShelf.swift
//
// A focusable row of the day's generated collections, sitting above the
// Timeline grid. Selecting one opens its photos in the existing full-screen
// viewer — on a television the useful action is "show me these", not "filter
// the grid".
//
// The shelf renders nothing at all when there are no collections: a fresh
// install, a paused worker, or a day whose proposals all missed the result
// floor. An empty row with a "nothing here" message would push the actual
// photos down the screen to say nothing.

import MapleCloudKit
import SwiftUI

struct GeneratedSearchShelf: View {
  let collections: [GeneratedSearchCard]
  let covers: [String: SearchAsset]
  let session: TVCloudSession
  /// Called with the chosen collection; the host loads its assets and
  /// presents the viewer.
  let onSelect: (GeneratedSearchCard) -> Void

  var body: some View {
    if !collections.isEmpty {
      VStack(alignment: .leading, spacing: 12) {
        Text("Rediscover")
          .font(.headline)
          .foregroundStyle(MapleTVTheme.textMuted)
          .padding(.leading, 4)

        ScrollView(.horizontal, showsIndicators: false) {
          LazyHStack(spacing: 24) {
            ForEach(collections) { collection in
              GeneratedSearchCardView(
                collection: collection,
                cover: covers[collection.id],
                session: session
              ) {
                onSelect(collection)
              }
            }
          }
          .padding(.horizontal, 4)
          // Focus rings on tvOS draw outside the cell bounds; without room
          // they clip against the scroll view's edge.
          .padding(.vertical, 12)
        }
      }
    }
  }
}

private struct GeneratedSearchCardView: View {
  let collection: GeneratedSearchCard
  let cover: SearchAsset?
  let session: TVCloudSession
  let onSelect: () -> Void

  static let width: CGFloat = 360
  static let height: CGFloat = 200

  var body: some View {
    Button(action: onSelect) {
      ZStack(alignment: .bottomLeading) {
        coverImage
        caption
      }
      .frame(width: Self.width, height: Self.height)
      .clipShape(RoundedRectangle(cornerRadius: 12))
    }
    .buttonStyle(.card)
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
      .frame(width: Self.width, height: Self.height)
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
