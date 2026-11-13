// EditorSeed.swift — the best already-available still, drawn as the editor
// canvas until real pixels are on screen (#2374, #5731, #5755, #5758).
//
// The GPU canvas leaf mounts before it has presented a frame, and a
// not-yet-downloaded cloud asset sits in that state for the whole download —
// so without this the editor is a blank shell with a progress bar. The seed
// is the same thumbnail the grid / Preview already painted for this asset,
// so it is normally a cache hit; for an asset with no local file it then
// upgrades to the display-resolution preview.
//
// The seed is drawn by the GPU canvas itself, as its placeholder
// (`EditSession.showCanvasPlaceholder`), on the same surface and in the same
// frame as the render, and its aspect lays the canvas out while the photo's
// real size is unknown (`CanvasZoomController.setProvisionalImageSize`). A
// pinch, pan or double-tap on the seed therefore moves the same frame the
// final image is drawn in, and when the RAW lands only the pixels change.
//
// The fetch/decode lives in `EditorSeed+VM.swift` (pattern #192) and the
// shared state in `EditorSeedStore`; this file is the loader and the view a
// canvas without the GPU placeholder falls back to.

import MapleCore
import SwiftUI

/// Loads the seed, hands it to the GPU canvas and lays the canvas out at its
/// aspect until the real size is known.
struct EditorSeedLoader: View {
  let asset: AssetRef
  /// The ambient source for URL-backed assets (the filmstrip's), when the
  /// host has one; `nil` routes through the ref's own provenance.
  let source: (any ImageSource)?
  let visible: Bool
  let store: EditorSeedStore
  let zoom: CanvasZoomController
  let session: EditSession

  /// The store belongs to the editor state, which a host can rebuild for
  /// the same photo; a new store loads again.
  private struct SeedKey: Equatable {
    let assetID: AssetRef.ID
    let store: ObjectIdentifier
  }

  private struct DisplayTierKey: Equatable {
    let seed: SeedKey
    let visible: Bool
  }

  /// The editor can hand the canvas a new controller for the same photo, so
  /// the stand-in extent follows the controller as well as the seed.
  private struct ProvisionalExtentKey: Equatable {
    let controller: ObjectIdentifier
    let seed: ObjectIdentifier?
  }

  /// A new still or a new session (and so a new canvas driver) re-presents.
  private struct PlaceholderKey: Equatable {
    let session: ObjectIdentifier
    let seed: ObjectIdentifier?
    let visible: Bool
  }

  var body: some View {
    let seed = store.image(for: asset.id)
    let seedKey = SeedKey(assetID: asset.id, store: ObjectIdentifier(store))
    Color.clear
      .frame(width: 0, height: 0)
      .allowsHitTesting(false)
      .accessibilityHidden(true)
      .task(id: seedKey) {
        // The cancellation guard matters: `.task(id:)` reuses this view
        // across an id change, and the superseded load can still land.
        store.begin(asset.id)
        let loaded = await EditorSeedVM.load(asset: asset, source: source)
        guard !Task.isCancelled, let loaded else { return }
        store.publish(loaded, for: asset.id, isDisplayPreview: false)
      }
      // Keyed on visibility too, so real pixels landing cancel the
      // network fetch instead of letting it compete with the download.
      .task(id: DisplayTierKey(seed: seedKey, visible: visible)) {
        store.begin(asset.id)
        guard visible, !store.hasDisplayPreview(for: asset.id) else { return }
        let display = await EditorSeedVM.loadDisplayPreview(asset: asset, source: source)
        guard !Task.isCancelled, let display else { return }
        store.publish(display, for: asset.id, isDisplayPreview: true)
      }
      .task(
        id: PlaceholderKey(
          session: ObjectIdentifier(session), seed: seed.map(ObjectIdentifier.init),
          visible: visible)
      ) {
        guard visible, let seed else { return }
        await session.showCanvasPlaceholder(seed)
      }
      .onChange(
        of: ProvisionalExtentKey(
          controller: ObjectIdentifier(zoom), seed: seed.map(ObjectIdentifier.init)),
        initial: true
      ) {
        guard let seed else { return }
        zoom.setProvisionalImageSize(
          EditorCanvasSeed.provisionalImageSize(
            forSeedOfPixelSize: CGSize(width: seed.width, height: seed.height)))
      }
  }
}

/// The seed drawn in the zoom host's leaf for a canvas the GPU placeholder
/// cannot reach (a non-RAW photo, or the GPU canvas off).
struct EditorSeedImage: View {
  let assetID: AssetRef.ID
  let visible: Bool
  let store: EditorSeedStore

  var body: some View {
    ZStack {
      if visible, let image = store.image(for: assetID) {
        // Labelled, not `Image(decorative:)`: a decorative image is hidden
        // from the accessibility tree, taking the UI-test identifier with it.
        Image(image, scale: 1, label: Text("Loading preview"))
          .resizable()
          .interpolation(.high)
          .aspectRatio(contentMode: .fit)
          .transition(.opacity)
          .accessibilityIdentifier("editor-seed-thumbnail")
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .animation(MapleTokens.Motion.chromeHide, value: visible)
    .allowsHitTesting(false)
  }
}
