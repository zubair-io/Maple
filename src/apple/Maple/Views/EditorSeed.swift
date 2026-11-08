// EditorSeed.swift — the best already-available still, drawn as the editor
// canvas until real pixels are on screen (#2374, #5731, #5755).
//
// The GPU canvas leaf mounts opaque before it has presented a frame, and a
// not-yet-downloaded cloud asset sits in that state for the whole download —
// so without this the editor is a blank shell with a progress bar. The seed
// is the same thumbnail the grid / Preview already painted for this asset,
// so it is normally a cache hit; for an asset with no local file it then
// upgrades to the display-resolution preview.
//
// The seed is drawn inside the zoom host's leaf, at the photo's rect, and
// its aspect lays the canvas out while the photo's real size is unknown
// (`CanvasZoomController.setProvisionalImageSize`). A pinch, pan or
// double-tap on the seed therefore moves the same frame the final image is
// drawn in, and when the RAW lands only the pixels change. It retires once
// the canvas has real pixels (`EditorCanvasSeed.isVisible`), crossfading
// out on the chrome-hide curve.
//
// The fetch/decode lives in `EditorSeed+VM.swift` (pattern #192) and the
// shared state in `EditorSeedStore`; this file is the loader and the view.

import MapleCore
import SwiftUI

/// Loads the seed and lays the canvas out at its aspect until the real size
/// is known. Mounted outside the zoom host: the host only mounts its leaf
/// once there is a frame, and the frame comes from this seed.
struct EditorSeedLoader: View {
  let asset: AssetRef
  /// The ambient source for URL-backed assets (the filmstrip's), when the
  /// host has one; `nil` routes through the ref's own provenance.
  let source: (any ImageSource)?
  let visible: Bool
  let store: EditorSeedStore
  let zoom: CanvasZoomController

  private struct DisplayTierKey: Equatable {
    let assetID: AssetRef.ID
    let visible: Bool
  }

  /// The editor can hand the canvas a new controller for the same photo, so
  /// the stand-in extent follows the controller as well as the seed.
  private struct ProvisionalExtentKey: Equatable {
    let controller: ObjectIdentifier
    let seed: ObjectIdentifier?
  }

  var body: some View {
    let seed = store.image(for: asset.id)
    Color.clear
      .frame(width: 0, height: 0)
      .allowsHitTesting(false)
      .accessibilityHidden(true)
      .task(id: asset.id) {
        // The cancellation guard matters: `.task(id:)` reuses this view
        // across an id change, and the superseded load can still land.
        store.begin(asset.id)
        let loaded = await EditorSeedVM.load(asset: asset, source: source)
        guard !Task.isCancelled, let loaded else { return }
        store.publish(loaded, for: asset.id, isDisplayPreview: false)
      }
      // Keyed on visibility too, so real pixels landing cancel the
      // network fetch instead of letting it compete with the download.
      .task(id: DisplayTierKey(assetID: asset.id, visible: visible)) {
        store.begin(asset.id)
        guard visible, !store.hasDisplayPreview(for: asset.id) else { return }
        let display = await EditorSeedVM.loadDisplayPreview(asset: asset, source: source)
        guard !Task.isCancelled, let display else { return }
        store.publish(display, for: asset.id, isDisplayPreview: true)
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

/// The seed drawn in the zoom host's leaf, filling the photo's frame.
struct EditorSeedImage: View {
  let assetID: AssetRef.ID
  let visible: Bool
  let store: EditorSeedStore

  var body: some View {
    ZStack {
      if visible, let image = store.image(for: assetID) {
        // Labelled, not `Image(decorative:)`: this is the only thing
        // on screen while a cloud asset downloads, so a screen reader
        // announcing "loading preview" is the correct behaviour —
        // and a decorative image is hidden from the accessibility
        // tree entirely, taking the UI-test identifier with it.
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
