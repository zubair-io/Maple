// EditorSeedThumbnail.swift — the best already-available still painted over
// the editor canvas until real pixels are on screen (#2374, #5731).
//
// The GPU canvas leaf mounts opaque before it has presented a frame, and a
// not-yet-downloaded cloud asset sits in that state for the whole download —
// so without this the editor is a blank shell with a progress bar. The seed
// is the same thumbnail the grid / Preview already painted for this asset,
// so it is normally a cache hit; for an asset with no local file it then
// upgrades to the display-resolution preview. It retires once the canvas has
// a frame and real pixels in it (`EditorCanvasSeed.isVisible`), crossfading
// out on the chrome-hide curve.
//
// Independent of any hero/zoom wiring — it keys only on data the editor can
// fetch itself, so it works on every editor entry point (#2374 proposal),
// unlike the retired `HeroSeedImage`, which only the iPhone Search tab's
// overlay ever fed.
//
// The fetch/decode lives in `EditorSeedThumbnail+VM.swift` (pattern #192);
// this file is presentation only.

import MapleCore
import SwiftUI

struct EditorSeedThumbnail: View {
  let asset: AssetRef
  /// The ambient source for URL-backed assets (the filmstrip's), when the
  /// host has one; `nil` routes through the ref's own provenance.
  let source: (any ImageSource)?
  let showingOriginal: Bool
  let hasOnscreenFrame: Bool
  /// Read here rather than by the canvas so pan and zoom frames only
  /// re-evaluate this small view.
  let zoom: CanvasZoomController

  @State private var thumbnail: CGImage?
  @State private var displayPreview: (assetID: AssetRef.ID, image: CGImage)?

  private var visible: Bool {
    EditorCanvasSeed.isVisible(
      showingOriginal: showingOriginal, hasOnscreenFrame: hasOnscreenFrame,
      hasDisplayFrame: zoom.displayFrameInPoints != nil)
  }

  private var image: CGImage? {
    displayPreview.flatMap { $0.assetID == asset.id ? $0.image : nil } ?? thumbnail
  }

  private struct DisplayTierKey: Equatable {
    let assetID: AssetRef.ID
    let visible: Bool
  }

  var body: some View {
    let visible = visible
    ZStack {
      if visible, let image {
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
    .task(id: asset.id) {
      // Drop the previous asset's seed before awaiting: `.task(id:)`
      // reuses this view's state across an id change, so leaving it in
      // place flashes the last photo's thumbnail over the new one for
      // the length of the fetch. The cancellation guard is the other
      // half — the superseded task can still land after its await.
      thumbnail = nil
      let loaded = await EditorSeedThumbnailVM.load(asset: asset, source: source)
      guard !Task.isCancelled else { return }
      thumbnail = loaded
    }
    // Keyed on visibility too, so real pixels landing cancel the
    // network fetch instead of letting it compete with the download.
    .task(id: DisplayTierKey(assetID: asset.id, visible: visible)) {
      guard visible, displayPreview?.assetID != asset.id else { return }
      let display = await EditorSeedThumbnailVM.loadDisplayPreview(
        asset: asset, source: source)
      guard !Task.isCancelled, let display else { return }
      displayPreview = (asset.id, display)
    }
  }
}
