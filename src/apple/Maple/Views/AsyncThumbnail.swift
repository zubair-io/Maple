// AsyncThumbnail.swift — shared thumbnail load lifecycle (#959).
//
// `FilmstripCell` (FilmstripView.swift) and `FilmstripRailCell`
// (FilmstripRail.swift) each hand-rolled the same lazy-load / decode /
// cancel / memoise dance around `ThumbnailLoader.shared`. This extracts
// that lifecycle into one reusable view: callers only describe how to
// render the decoded bitmap (or the empty state while it's `nil`) via
// `content`, matching each cell's own chrome (corner radius, selection
// ring, arrival transition) without duplicating the load logic itself.

import MapleCore
import SwiftUI

struct AsyncThumbnail<Content: View>: View {
  let asset: AssetRef
  /// Source the asset came from — forwarded to `ThumbnailLoader` so the
  /// sourceless thumb path (cloud / PhotoKit / self-hosted) can resolve.
  /// `nil` for filesystem assets, which load straight off `primaryURL`.
  let source: (any ImageSource)?
  @ViewBuilder let content: (CGImage?) -> Content

  /// Decoded thumbnail bitmap from `ThumbnailLoader` + `ThumbnailDecoder`.
  /// `nil` while loading / on failure, in which case `content` renders its
  /// own empty state. Decoded off the main actor (never in `body`).
  @State private var decoded: CGImage?

  private var decodedKey: String {
    DevelopedImageRevision.shared.decodedKey(
      for: asset.stableID ?? asset.id.uuidString, url: asset.primaryURL)
  }

  var body: some View {
    content(decoded)
      .task(id: decodedKey) {
        await load(key: decodedKey)
      }
  }

  private func load(key: String) async {
    let capturedAsset = asset
    let capturedSource = source
    let bytes = await ThumbnailLoader.shared.load(
      for: capturedAsset, from: capturedSource
    )
    guard !Task.isCancelled else { return }
    // Decode off the main actor before touching view state — never in
    // `body`. Keyed on the asset id plus its saved-image revision. No arrival
    // fade: it hitches scroll the same way it does in the grid.
    let image = await ThumbnailDecoder.image(
      for: bytes, key: key)
    guard !Task.isCancelled else { return }
    decoded = image
  }
}
