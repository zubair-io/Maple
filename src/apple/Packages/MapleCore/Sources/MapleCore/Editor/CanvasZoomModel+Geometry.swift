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
    /// `magnification` is cumulative since gesture begin. Clamps below
    /// to `fit × 0.5` (pinch slightly past fit before the snap) and
    /// above to the cap.
    public static func pinchScale(
        start: CGFloat,
        magnification: CGFloat,
        fit: CGFloat,
        maxScale: CGFloat = maxPixelScale
    ) -> CGFloat {
        max(fit * 0.5, min(start * magnification, maxScale))
    }

    /// True when `scale` should snap back to fit mode.
    public static func shouldSnapToFit(_ scale: CGFloat, fit: CGFloat) -> Bool {
        scale <= fit * snapToFitTolerance
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

    /// ⌘- step from `current`: divide by `zoomStep`, snap when within
    /// tolerance of fit, otherwise floor at `fit × 0.5`.
    public static func zoomOutTarget(current: CGFloat, fit: CGFloat) -> ZoomOutResult {
        let next = current / zoomStep
        if next <= fit * snapToFitTolerance {
            return .snapToFit
        }
        return .scale(max(next, fit * 0.5))
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

    /// Anchor (a unit point of the canvas leaf's frame) for a live pinch's
    /// `.scaleEffect`, so scaling the leaf keeps the image point under the
    /// gesture focal fixed (#1493). The leaf is centred in the viewport and then
    /// shifted by the committed pan; the focal (viewport points) maps into the
    /// leaf's frame as a unit point.
    ///
    /// The result MAY fall outside `0...1` when the focal lies in the
    /// letterboxed margin around the image — that is intentional and valid for
    /// SwiftUI's `.scaleEffect(anchor:)` (an out-of-bounds anchor scales about a
    /// point outside the view); clamping it would shift the anchor and break the
    /// focal-fixed property. Returned as a `CGPoint` (the host wraps it in a
    /// `UnitPoint`) so it's unit-testable in the pure model. Degenerate frame →
    /// centre.
    public static func pinchAnchorUnit(
        focal: CGPoint,
        viewport: CGSize,
        committedPan: CGSize,
        frame: CGSize
    ) -> CGPoint {
        guard frame.width > 0, frame.height > 0 else { return CGPoint(x: 0.5, y: 0.5) }
        // Leaf frame's top-left on screen: centred, then offset by committedPan.
        let originX = viewport.width / 2 + committedPan.width - frame.width / 2
        let originY = viewport.height / 2 + committedPan.height - frame.height / 2
        return CGPoint(
            x: (focal.x - originX) / frame.width,
            y: (focal.y - originY) / frame.height
        )
    }
}
