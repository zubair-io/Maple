// HeroZoomGeometry.swift — pure geometry for the editor's hand-rolled
// zoom-to-open transition (#1489).
//
// The transition is hand-rolled rather than built on SwiftUI's
// `.navigationTransition(.zoom(sourceID:in:))` because that API ships a
// non-configurable interactive pinch-to-dismiss. It fights the editor's own
// pinch-zoom (`CanvasZoomHost`): both recognizers claim the same gesture, the
// system one wins even under `.highPriorityGesture`, and the editor collapses
// toward the grid tile while the user is still zooming in. Owning the
// transition means owning its arithmetic, and it lives here — next to
// `CanvasZoomModel`, whose fit geometry it has to agree with — so it is
// testable without a view hierarchy.
//
// Two coordinate facts the presentation relies on:
//   • `fitRect` reproduces what the canvas paints at fit, so the flying
//     thumbnail lands exactly on the rect the canvas is about to fill.
//   • `closeProgress` maps a pinch-in magnification onto the same 0…1
//     progress the open animation drives, so the interactive close is the
//     open animation run backwards rather than a second code path.

import CoreGraphics

public enum HeroZoomGeometry {

    // MARK: - Close-gesture thresholds

    /// Magnification at which an at-fit pinch-in reads as fully collapsed
    /// onto the source tile. Fingers rarely travel below half scale on a
    /// phone-sized canvas, so anything at or under this is "all the way".
    public static let closeFullyCollapsedMagnification: CGFloat = 0.5

    /// Releasing at or below this magnification commits the close; above it
    /// the transition springs back open. Deliberately close to 1 — a
    /// deliberate pinch passes it well before the fingers meet, and an
    /// accidental twitch does not.
    public static let closeCommitMagnification: CGFloat = 0.82

    // MARK: - Rects

    /// Aspect-fit rect for an image of `aspectRatio` (width ÷ height)
    /// centred in `size`, in that container's own coordinate space.
    ///
    /// Degenerate inputs (non-finite or non-positive aspect, empty
    /// container) fall back to the container rect: the caller is mid-layout
    /// and a full-bleed rect is the least surprising placeholder.
    public static func fitRect(aspectRatio: CGFloat, in size: CGSize) -> CGRect {
        guard aspectRatio.isFinite, aspectRatio > 0,
              size.width > 0, size.height > 0
        else { return CGRect(origin: .zero, size: size) }

        let containerAspect = size.width / size.height
        let fitted = containerAspect > aspectRatio
            ? CGSize(width: size.height * aspectRatio, height: size.height)
            : CGSize(width: size.width, height: size.width / aspectRatio)
        return CGRect(
            x: (size.width - fitted.width) / 2,
            y: (size.height - fitted.height) / 2,
            width: fitted.width,
            height: fitted.height
        )
    }

    /// Linear interpolation between two rects — `progress` 0 yields `from`,
    /// 1 yields `to`. Deliberately unclamped so a spring that overshoots
    /// past 1 keeps carrying the hero past its destination instead of
    /// freezing there.
    public static func interpolate(from: CGRect, to: CGRect, progress: CGFloat) -> CGRect {
        CGRect(
            x: interpolate(from: from.origin.x, to: to.origin.x, progress: progress),
            y: interpolate(from: from.origin.y, to: to.origin.y, progress: progress),
            width: interpolate(from: from.size.width, to: to.size.width, progress: progress),
            height: interpolate(from: from.size.height, to: to.size.height, progress: progress)
        )
    }

    /// Scalar lerp — the corner-radius and opacity ramps ride on this.
    public static func interpolate(from: CGFloat, to: CGFloat, progress: CGFloat) -> CGFloat {
        from + (to - from) * progress
    }

    // MARK: - Ramps

    /// Remaps `progress` onto a later, steeper ramp so a layer can trail the
    /// hero instead of fading in lockstep with it. `start` is the progress
    /// at which the layer begins to appear; below it the result is 0, at 1
    /// it is 1.
    public static func delayedRamp(progress: CGFloat, start: CGFloat) -> CGFloat {
        guard start < 1 else { return progress >= 1 ? 1 : 0 }
        let span = 1 - max(start, 0)
        let t = (progress - max(start, 0)) / span
        return min(max(t, 0), 1)
    }

    // MARK: - Interactive close

    /// Open-progress for an at-fit pinch-in: 1 while the fingers are still,
    /// falling to 0 as they close. Feeding this straight into the same
    /// progress the open animation drives makes the close the open played
    /// backwards, under the user's fingers.
    public static func closeProgress(magnification: CGFloat) -> CGFloat {
        guard magnification.isFinite else { return 1 }
        let span = 1 - closeFullyCollapsedMagnification
        let t = (magnification - closeFullyCollapsedMagnification) / span
        return min(max(t, 0), 1)
    }

    /// Whether releasing the pinch at `magnification` commits the close.
    public static func shouldCommitClose(magnification: CGFloat) -> Bool {
        magnification.isFinite && magnification <= closeCommitMagnification
    }
}
