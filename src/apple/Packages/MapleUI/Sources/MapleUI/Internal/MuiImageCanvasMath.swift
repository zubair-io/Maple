// MuiImageCanvasMath.swift — pure zoom/pan math for `MuiImageCanvas`.
// Ported from the web reference's `clampScale`/`zoomToPoint`
// (mui-image-canvas.component.ts): zoom-to-point recomputes the pan offset
// so the content-space point under the gesture's anchor stays under that
// same anchor after the scale changes, via `newOffset = anchor - (anchor -
// oldOffset) * (newScale / oldScale)`, applied per axis.

import CoreGraphics

public struct MuiImageTransform: Equatable, Sendable {
    public var x: CGFloat
    public var y: CGFloat
    public var scale: CGFloat

    public init(x: CGFloat = 0, y: CGFloat = 0, scale: CGFloat = 1) {
        self.x = x
        self.y = y
        self.scale = scale
    }
}

enum MuiImageCanvasMath {
    static let minScale: CGFloat = 0.1
    static let maxScale: CGFloat = 8

    static func clampScale(_ scale: CGFloat) -> CGFloat {
        Swift.min(maxScale, Swift.max(minScale, scale))
    }

    /// Zoom-to-point: `transform.scale` becomes `nextScale` (already
    /// clamped by the caller) while the content-space point under
    /// `(anchorX, anchorY)` stays visually fixed under that same point.
    static func zoomToPoint(transform: MuiImageTransform, anchorX: CGFloat, anchorY: CGFloat, nextScale: CGFloat) -> MuiImageTransform {
        guard transform.scale != 0 else { return MuiImageTransform(x: transform.x, y: transform.y, scale: nextScale) }
        let ratio = nextScale / transform.scale
        return MuiImageTransform(
            x: anchorX - (anchorX - transform.x) * ratio,
            y: anchorY - (anchorY - transform.y) * ratio,
            scale: nextScale
        )
    }

    /// The transform after a continuous pan drag of `(dx, dy)` starting
    /// from `startTransform` — scale is unaffected by a pan.
    static func panned(startTransform: MuiImageTransform, dx: CGFloat, dy: CGFloat) -> MuiImageTransform {
        MuiImageTransform(x: startTransform.x + dx, y: startTransform.y + dy, scale: startTransform.scale)
    }
}
