// HeroZoom.swift — value types and leaf views for the editor's zoom-to-open
// transition (#1489).
//
// The transition is hand-rolled: SwiftUI's
// `.navigationTransition(.zoom(sourceID:in:))` bundles an interactive
// pinch-to-dismiss that cannot be turned off, and it wins the gesture over
// `CanvasZoomHost`'s own pinch — so a user zooming into their photo would
// instead watch the editor shrink back into the grid. Everything here exists
// so the presentation (`HeroZoomEditorOverlay`) owns both gestures outright.
//
// Two images are in play and they are deliberately the SAME bytes:
//   • the FLYING image, drawn by the overlay above the editor, travelling
//     from the tapped tile to the canvas's fit rect, and
//   • the SEED image, drawn by `EditorView` at that same fit rect until the
//     first real frame lands.
// They coincide the instant the flight ends, so the hand-off is a no-op
// rather than a cross-fade — and a cloud asset that has not been downloaded
// yet shows the photo throughout instead of a blank "Downloading…" shell.
//
// The leaf views live here rather than in `EditorView+Canvas.swift` because
// the seed is also what the overlay flies; keeping both next to the value
// types they share is what makes the "same bytes, same rect" contract legible.

import SwiftUI
import CoreGraphics
import MapleCore

// MARK: - PhotoGridHeroSource

/// What a grid cell hands back when it is tapped on a surface that presents
/// the editor with a hero zoom: the thumbnail it is currently painting and
/// the exact rect it occupies on screen.
///
/// The thumbnail is already decoded (the cell painted it), so building this
/// costs a `CGImageSource` decode of bytes that are in memory — no I/O.
struct PhotoGridHeroSource {
    /// The decoded grid thumbnail. Carries the photo's natural aspect ratio;
    /// the *cell* crops it to a square, the image itself is uncropped.
    let thumbnail: CGImage
    /// The cell's frame in global (window) coordinates.
    let frame: CGRect
    /// The cell's corner radius, interpolated to 0 as the hero opens.
    let cornerRadius: CGFloat

    /// Width ÷ height of the underlying photo — the aspect the canvas will
    /// fit the developed image into.
    var aspectRatio: CGFloat {
        guard thumbnail.height > 0 else { return 1 }
        return CGFloat(thumbnail.width) / CGFloat(thumbnail.height)
    }
}

// MARK: - EditorHeroZoom

/// Hero wiring handed to `EditorView` while `HeroZoomEditorOverlay` is
/// presenting it. `nil` on every other entry point (the pushed
/// `EditorDestination`, `EditorSessionHost`, previews), which leaves the
/// editor's behaviour byte-for-byte unchanged there.
struct EditorHeroZoom {
    /// The grid thumbnail, painted over the canvas until a real frame is on
    /// screen. `nil` when the tapped cell had not loaded its thumbnail yet —
    /// the transition degrades to a plain fade rather than inventing pixels.
    let seedImage: CGImage?
    /// Reports the canvas region in global coordinates. This is the overlay's
    /// destination geometry: it cannot compute the fit rect itself, because
    /// the canvas region is inset by whatever safe area and chrome the editor
    /// resolves at layout time.
    let onCanvasFrame: (CGRect) -> Void
    /// Live open-progress for an at-fit pinch-in (1 = open, 0 = collapsed).
    let onCloseProgress: (CGFloat) -> Void
    /// Pinch release — `true` commits the close, `false` springs back open.
    let onCloseEnded: (Bool) -> Void
}

// MARK: - Leaf views

/// The grid thumbnail painted at the canvas's fit rect.
///
/// Sits ABOVE the canvas rather than behind it: the GPU live layer mounts
/// opaque before it has presented a frame, so a seed underneath would be
/// covered by exactly the black shell this exists to prevent. It is
/// non-interactive and hidden from VoiceOver — the canvas below it owns both.
struct HeroSeedImage: View {
    let image: CGImage

    var body: some View {
        Image(decorative: image, scale: 1)
            .resizable()
            .interpolation(.high)
            .aspectRatio(contentMode: .fit)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

/// The thumbnail in flight between the grid tile and the canvas.
///
/// Drawn `.fill`-cropped into `rect`: at the start `rect` is the square tile
/// and the crop reproduces the grid cell exactly, and at the end `rect`
/// carries the photo's own aspect, where fill and fit coincide. That is what
/// makes the tile visibly *un-crop* as it opens instead of snapping.
struct HeroFlyingImage: View {
    let image: CGImage
    /// Destination rect in the presenting overlay's coordinate space.
    let rect: CGRect
    let cornerRadius: CGFloat

    var body: some View {
        Image(decorative: image, scale: 1)
            .resizable()
            .interpolation(.high)
            .aspectRatio(contentMode: .fill)
            .frame(width: max(rect.width, 0), height: max(rect.height, 0))
            .clipShape(RoundedRectangle(cornerRadius: max(cornerRadius, 0)))
            .position(x: rect.midX, y: rect.midY)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}
