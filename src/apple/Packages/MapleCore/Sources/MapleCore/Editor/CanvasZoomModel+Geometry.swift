// CanvasZoomModel+Geometry.swift — pure zoom/pan geometry (#1099, #1493).
//
// Static, side-effect-free math split out of `CanvasZoomModel` (file-budget):
// the scale clamps + zoom-step targets, and the focal-anchored pan derivations
// the gesture transitions and the iOS compositor pinch rely on. Pure functions
// of their inputs — unit-tested without SwiftUI or an actor.

import Foundation
import CoreGraphics

extension CanvasZoomModel {

    // MARK: Scale clamps + zoom steps

    /// Live pinch math: `start` is the scale captured at gesture begin,
    /// `magnification` is cumulative since gesture begin. Clamps to
    /// `fit × minFitFraction … maxScale`, then settles on the fit or fill
    /// detent when within its band. The band is a fixed region of the
    /// cumulative magnification, so the fingers move straight out of it.
    public static func pinchScale(
        start: CGFloat,
        magnification: CGFloat,
        fit: CGFloat,
        fill: CGFloat,
        maxScale: CGFloat = maxPixelScale
    ) -> CGFloat {
        let clamped = max(fit * minFitFraction, min(start * magnification, maxScale))
        switch detent(for: clamped, fit: fit, fill: fill) {
        case .fit: return fit
        case .fill: return fill
        case .actualSize, nil: return clamped
        }
    }

    /// The fit or fill stop `scale` sits within `detentTolerance` of, the
    /// nearer one when both bands overlap (fit wins a tie). `nil` outside
    /// both bands.
    public static func detent(for scale: CGFloat, fit: CGFloat, fill: CGFloat) -> ZoomStop? {
        let fitDistance = relativeDistance(scale, fit)
        let fillDistance = relativeDistance(scale, fill)
        guard min(fitDistance, fillDistance) <= detentTolerance else { return nil }
        return fitDistance <= fillDistance ? .fit : .fill
    }

    /// True when a discrete zoom from `current` toward `next` reaches fit's
    /// detent band from the far side — the step settles on fit instead of
    /// jumping over it. Starting exactly at fit is never a crossing, so the
    /// next step leaves fit in either direction; the band is entered only
    /// while moving toward fit, so small steps away from it cannot be
    /// pulled back.
    public static func crossesFit(from current: CGFloat, to next: CGFloat, fit: CGFloat) -> Bool {
        let zoomingOut = next < current
        return zoomingOut
            ? current > fit && next <= fit * (1 + detentTolerance)
            : current < fit && next >= fit * (1 - detentTolerance)
    }

    /// Clamps a programmatic zoom target (toolbar "100%", ⌘1).
    public static func clampedExplicitZoom(
        _ scale: CGFloat, maxScale: CGFloat = maxPixelScale
    ) -> CGFloat {
        min(max(scale, minExplicitZoom), maxScale)
    }

    /// Next scale after a ⌘= zoom-in step.
    public static func zoomInTarget(
        current: CGFloat, maxScale: CGFloat = maxPixelScale
    ) -> CGFloat {
        min(current * zoomStep, maxScale)
    }

    /// Outcome of a ⌘- zoom-out step.
    public enum ZoomOutResult: Equatable, Sendable {
        /// Reset to fit mode (pixelScale = 0, pans cleared).
        case snapToFit
        /// Apply this concrete pixelScale.
        case scale(CGFloat)
    }

    /// ⌘- step from `current`: divide by `zoomStep`. A step from above fit
    /// that lands within the detent band of fit (or below it) settles on
    /// fit; from fit or below it continues down to `fit × minFitFraction`.
    public static func zoomOutTarget(current: CGFloat, fit: CGFloat) -> ZoomOutResult {
        let next = current / zoomStep
        if crossesFit(from: current, to: next, fit: fit) {
            return .snapToFit
        }
        return .scale(max(next, fit * minFitFraction))
    }

    // MARK: Zoom stops

    /// The named zoom levels the badge cycles through.
    public enum ZoomStop: Equatable, Sendable {
        case fit
        /// The image covers the whole viewport (no letterbox).
        case fill
        /// 100% — one image pixel per real screen pixel.
        case actualSize
    }

    /// The cycle `fit → fill → 100%`, dropping a stop whose scale falls
    /// within the detent band of an earlier one (an image whose aspect
    /// matches the viewport has no separate fill; a small image may fit
    /// at 100%). `actualSize` is the scale of the 100% stop, or `nil` on a
    /// surface without one.
    public static func distinctStops(
        fit: CGFloat, fill: CGFloat, actualSize: CGFloat?
    ) -> [ZoomStop] {
        let candidates: [(ZoomStop, CGFloat)] =
            [(.fit, fit), (.fill, fill)] + (actualSize.map { [(.actualSize, $0)] } ?? [])
        return candidates.reduce(into: [(ZoomStop, CGFloat)]()) { kept, candidate in
            let isDistinct = kept.allSatisfy {
                relativeDistance(candidate.1, $0.1) > detentTolerance
            }
            if isDistinct { kept.append(candidate) }
        }.map(\.0)
    }

    /// The stop after `current` in `stops`, wrapping; any zoom that is not
    /// a stop (a pinched or stepped scale) returns to fit.
    public static func nextStop(after current: ZoomStop?, in stops: [ZoomStop]) -> ZoomStop {
        guard let current, let index = stops.firstIndex(of: current) else { return .fit }
        return stops[(index + 1) % stops.count]
    }

    private static func relativeDistance(_ scale: CGFloat, _ stop: CGFloat) -> CGFloat {
        guard stop > 0 else { return .infinity }
        return abs(scale / stop - 1)
    }

    // MARK: Focal-anchored pan

    /// Pan that keeps the image point under `anchor` (viewport points)
    /// fixed across a scale change `startScale → newScale`, given the
    /// pan at gesture start. Derivation: a screen point `q` maps to the
    /// image-relative point `u = (q − C − p₀)·ds/s₀` (C = viewport
    /// center); requiring `q = C + p₁ + u·s₁/ds` yields
    /// `p₁ = (q − C) − ((q − C) − p₀)·(s₁/s₀)` — display scale and the
    /// image size cancel out.
    public static func anchoredPan(
        anchor: CGPoint,
        viewportPoints: CGSize,
        startPan: CGSize,
        startScale: CGFloat,
        newScale: CGFloat
    ) -> CGSize {
        guard startScale > 0 else { return startPan }
        let ax = anchor.x - viewportPoints.width / 2
        let ay = anchor.y - viewportPoints.height / 2
        let ratio = newScale / startScale
        return CGSize(
            width: ax - (ax - startPan.width) * ratio,
            height: ay - (ay - startPan.height) * ratio
        )
    }

    /// Pan that keeps the image point under the gesture's START centroid fixed
    /// under the LIVE centroid, across a `startScale → newScale` change. Derived
    /// fresh from the START values every frame (never the previous frame), so
    /// per-frame pan clamping can't accumulate and drift the anchor. A static,
    /// pure function of its inputs — easy to unit-test.
    ///
    /// `newPan = aLive − (aStart − startPan)·(newScale/startScale)`
    /// where `a· = centroid − viewportCenter`. Pure scale (centroids equal)
    /// reduces to a start-anchored zoom; pure centroid drift (scales equal)
    /// translates the pan by the centroid delta (pan-while-pinch).
    public static func livePinchPan(
        liveCentroid: CGPoint,
        startCentroid: CGPoint,
        startPan: CGSize,
        startScale: CGFloat,
        newScale: CGFloat,
        viewportPoints: CGSize
    ) -> CGSize {
        guard startScale > 0 else { return startPan }
        let halfW = viewportPoints.width / 2
        let halfH = viewportPoints.height / 2
        let ratio = newScale / startScale
        return CGSize(
            width: (liveCentroid.x - halfW) - ((startCentroid.x - halfW) - startPan.width) * ratio,
            height: (liveCentroid.y - halfH) - ((startCentroid.y - halfH) - startPan.height) * ratio
        )
    }

}
