// RetouchOverlayGeometry.swift — where a repair spot goes on screen, and
// which handle a press grabs (#3409). Pure CoreGraphics: no SwiftUI, no
// session, so the unit tests drive it directly.
//
// Placement follows the CANVAS, not a fit assumption — the same rule
// `MaskOverlayGeometry` established (#3354): the spot list lives in
// full-frame normalised coordinates, so every point is placed inside
// `MaskOverlayGeometry.fullFrameRect` and the whole overlay is rotated by
// the straighten angle about that rect's centre, exactly as the canvas
// rotates its pixels. Input runs the same transform backwards.

import CoreGraphics
import Foundation

/// The two draggable points of a spot.
public enum RetouchHandle: String, Equatable, Sendable, CaseIterable {
    case destination
    case source

    public var displayName: String {
        switch self {
        case .destination: return "Destination"
        case .source: return "Source"
        }
    }
}

public enum RetouchOverlayGeometry {
    /// Grab slack beyond the disc itself, in points — matches the crop
    /// overlay's handle tolerance so every canvas overlay feels the same.
    public static let handleTolerance: CGFloat = 14

    /// Screen position of a normalised point inside `fullFrame`, BEFORE the
    /// straighten rotation. Rotation is an isometry, so distances measured
    /// on these points are the same ones the drawn overlay shows — which is
    /// why hit-testing uses this form and only drawing needs the angle.
    public static func screenPoint(_ p: RetouchPoint, fullFrame: CGRect) -> CGPoint {
        CGPoint(
            x: fullFrame.minX + CGFloat(p.x) * fullFrame.width,
            y: fullFrame.minY + CGFloat(p.y) * fullFrame.height)
    }

    /// Screen position with the straighten rotation applied about
    /// `fullFrame`'s centre — where the overlay actually draws the point,
    /// and the exact inverse of [`normalizedPoint(from:fullFrame:angleDegrees:)`].
    public static func screenPoint(
        _ p: RetouchPoint, fullFrame: CGRect, angleDegrees: Double
    ) -> CGPoint {
        let flat = screenPoint(p, fullFrame: fullFrame)
        guard angleDegrees != 0 else { return flat }
        let centre = CGPoint(x: fullFrame.midX, y: fullFrame.midY)
        let radians = angleDegrees * Double.pi / 180
        let dx = Double(flat.x - centre.x)
        let dy = Double(flat.y - centre.y)
        return CGPoint(
            x: centre.x + CGFloat(dx * cos(radians) - dy * sin(radians)),
            y: centre.y + CGFloat(dx * sin(radians) + dy * cos(radians)))
    }

    /// A spot's disc radius in points. `radius` is a fraction of the image
    /// WIDTH and the disc is a circle in pixels, so one scale serves both
    /// axes (`RetouchSpot`'s doc comment).
    public static func radiusPoints(_ radius: Double, fullFrame: CGRect) -> CGFloat {
        CGFloat(radius) * fullFrame.width
    }

    /// Undo the straighten rotation about `fullFrame`'s centre, then express
    /// the result as normalised full-frame coordinates clamped to `[0, 1]`.
    /// The inverse of `screenPoint` plus the caller's `.rotationEffect`.
    public static func normalizedPoint(
        from screen: CGPoint, fullFrame: CGRect, angleDegrees: Double
    ) -> RetouchPoint {
        let centre = CGPoint(x: fullFrame.midX, y: fullFrame.midY)
        let radians = -angleDegrees * Double.pi / 180
        let dx = Double(screen.x - centre.x)
        let dy = Double(screen.y - centre.y)
        let cosA = cos(radians)
        let sinA = sin(radians)
        let rx = dx * cosA - dy * sinA
        let ry = dx * sinA + dy * cosA
        let x = (Double(centre.x) + rx - Double(fullFrame.minX)) / Double(fullFrame.width)
        let y = (Double(centre.y) + ry - Double(fullFrame.minY)) / Double(fullFrame.height)
        return RetouchPoint(x: min(1, max(0, x)), y: min(1, max(0, y)))
    }

    /// True when the normalised point `p` lands within grabbing distance of
    /// `target`, given `spot`'s disc size.
    public static func contains(
        _ p: RetouchPoint, target: RetouchPoint, spot: RetouchSpot, fullFrame: CGRect
    ) -> Bool {
        let reach = max(handleTolerance, radiusPoints(spot.radius, fullFrame: fullFrame))
        let a = screenPoint(p, fullFrame: fullFrame)
        let b = screenPoint(target, fullFrame: fullFrame)
        return hypot(a.x - b.x, a.y - b.y) <= reach
    }

    /// Which handle of `spot` a press at the normalised point `p` grabs, or
    /// nil. The source wins ties because it sits on top: a freshly-placed
    /// spot puts both discs close together and the source is the one the
    /// user then drags away.
    public static func hitTest(
        _ p: RetouchPoint, spot: RetouchSpot, fullFrame: CGRect
    ) -> RetouchHandle? {
        if contains(p, target: spot.source, spot: spot, fullFrame: fullFrame) { return .source }
        if contains(p, target: spot.center, spot: spot, fullFrame: fullFrame) {
            return .destination
        }
        return nil
    }

    /// Move one handle to `point`, preserving the grab offset (`anchor` is
    /// where the press landed). Dragging the destination carries the source
    /// with it, so the sampled offset the user chose survives a reposition;
    /// dragging the source moves it alone.
    public static func drag(
        _ start: RetouchSpot, handle: RetouchHandle, to point: RetouchPoint,
        anchor: RetouchPoint
    ) -> RetouchSpot {
        let dx = point.x - anchor.x
        let dy = point.y - anchor.y
        let moved = { (p: RetouchPoint) in
            RetouchPoint(x: min(1, max(0, p.x + dx)), y: min(1, max(0, p.y + dy)))
        }
        var out = start
        switch handle {
        case .source:
            out.source = moved(start.source)
        case .destination:
            out.center = moved(start.center)
            out.source = moved(start.source)
        }
        return out
    }

    /// Where a brand-new spot samples from: one and a half radii to the
    /// right of the destination, mirrored left when that would leave the
    /// frame. A deterministic offset is what makes a placement reproducible.
    public static func defaultSource(for center: RetouchPoint, radius: Double) -> RetouchPoint {
        let offset = radius * 1.5
        let x = center.x + offset <= 1 ? center.x + offset : center.x - offset
        return RetouchPoint(x: min(1, max(0, x)), y: center.y)
    }
}
