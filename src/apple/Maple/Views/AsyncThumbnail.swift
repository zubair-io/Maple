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

  private var reloadKey: String {
    DevelopedImageRevision.shared.reloadKey(
      for: asset.stableID ?? asset.id.uuidString, source: .local(asset, source: nil))
  }

  var body: some View {
    content(decoded)
      .task(id: reloadKey) {
        let key = await DevelopedImageRevision.shared.decodedKeyAsync(
          for: asset.stableID ?? asset.id.uuidString, source: .local(asset, source: nil))
        guard !Task.isCancelled else { return }
        await load(key: key)
      }
  }

  private func load(key: String) async {
    if let cached = ThumbnailDecoder.cachedImage(forKey: key) {
      decoded = cached
      return
    }
    let cameraKey = "camera:" + key
    if let cachedCamera = ThumbnailDecoder.cachedImage(forKey: cameraKey) {
      decoded = cachedCamera
    }
    let capturedAsset = asset
    let capturedSource = source
    if decoded == nil,
      let cameraBytes = await ThumbnailLoader.shared.loadCameraPreview(for: capturedAsset),
      !Task.isCancelled,
      let cameraImage = await ThumbnailDecoder.image(for: cameraBytes, key: cameraKey),
      !Task.isCancelled
    {
      decoded = cameraImage
    }
    guard !Task.isCancelled else { return }
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
    if let image {
      decoded = image
    }
  }
}
