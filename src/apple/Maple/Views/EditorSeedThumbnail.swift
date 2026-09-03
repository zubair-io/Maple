// EditorSeedThumbnail.swift — the grid thumbnail painted over the editor
// canvas until real pixels are on screen (#2374).
//
// The GPU canvas leaf mounts opaque before it has presented a frame, and a
// not-yet-downloaded cloud asset sits in that state for the whole download —
// so without this the editor is a blank shell with a progress bar. The seed
// is the same thumbnail the grid / Preview already painted for this asset,
// so it is normally a cache hit (`ThumbnailDiskCache` for local + PhotoKit
// refs, `CloudThumbCache` for Maple Cloud refs), and it retires the moment
// `canvasHasOnscreenFrame` flips, crossfading out on the chrome-hide curve.
//
// Independent of any hero/zoom wiring — it keys only on data the editor can
// fetch itself, so it works on every editor entry point (#2374 proposal),
// unlike the retired `HeroSeedImage`, which only the iPhone Search tab's
// overlay ever fed.

import SwiftUI
import MapleCore
import MapleCloudKit

struct EditorSeedThumbnail: View {
    let asset: AssetRef
    /// The ambient source for URL-backed assets (the filmstrip's), when the
    /// host has one; `nil` routes through the ref's own provenance.
    let source: (any ImageSource)?
    /// `false` once the canvas has real pixels — the seed fades out.
    let visible: Bool

    @State private var image: CGImage?

    var body: some View {
        ZStack {
            if visible, let image {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .transition(.opacity)
                    .accessibilityLabel("Loading preview")
                    .accessibilityIdentifier("editor-seed-thumbnail")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(MapleTokens.Motion.chromeHide, value: visible)
        .allowsHitTesting(false)
        .task(id: asset.id) {
            image = await Self.load(asset: asset, source: source)
        }
    }

    /// The asset's existing thumbnail bytes, decoded. Cloud refs read the
    /// on-disk `CloudThumbCache` the grid populated (a fresh instance points
    /// at the same shared directory); everything else goes through the same
    /// `ThumbnailProvider` route the grid, filmstrip and Preview use. A miss
    /// simply leaves the canvas as it was — the seed is an enhancement, never
    /// a gate.
    static func load(asset: AssetRef, source: (any ImageSource)?) async -> CGImage? {
        let data: Data?
        if let catalog = asset.catalog {
            data = await CloudThumbCache().get(
                host: catalog.serverID.cacheHostKey, absPath: catalog.absPath)
        } else {
            data = await ThumbnailProvider.local()
                .thumbnail(for: PreviewViewVM.thumbnailSource(for: asset, source: source))
        }
        return await ThumbnailDecoder.image(for: data, key: "editor-seed:\(asset.id.uuidString)")
    }
}
