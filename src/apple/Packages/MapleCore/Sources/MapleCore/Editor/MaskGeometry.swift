// MaskGeometry.swift — pure geometry for the interactive mask overlay
// (#355): handle placement, hit-testing and drag semantics for the two mask
// shapes, plus the map between full-frame normalized mask coordinates and
// the canvas footprint. The SwiftUI overlay (`MaskOverlay` in the app
// target) is a thin painter over these functions, the same split
// `CropGeometry` / `CropOverlay` use, so the interaction math is
// unit-testable without a gesture.
//
// Coordinate spaces:
//   • full-frame normalized — the `LocalMask` coordinates raw-core
//     evaluates ([0, 1]² over the whole oriented image, origin top-left).
//   • crop-normalized — the same over the DISPLAYED (cropped + straightened)
//     region; identical to full-frame when no crop applies.
//   • footprint — the displayed image's on-screen rect in points at fit zoom
//     (`CropGeometry.fitFootprint`; the mask tool forces fit + zero pan).
// `MaskCanvasMap` chains the last two through `MaskAffine`, so a mask on a
// cropped image is drawn where the render actually applies it.

import CoreGraphics
import Foundation

/// The grab points the overlay exposes for the selected mask.
public enum MaskHandle: String, Equatable, Sendable, CaseIterable {
    /// Linear: the `w = 0` endpoint.
    case linearStart
    /// Linear: the `w = 1` endpoint.
    case linearEnd
    /// Linear: the midpoint — dragging it translates the whole gradient.
    case linearBody
    /// Radial: the ellipse center — dragging it translates the ellipse.
    case radialCenter
    /// Radial: the point on the ellipse along its local x axis — sets `rx`.
    case radialRadiusX
    /// Radial: the point on the ellipse along its local y axis — sets `ry`.
    case radialRadiusY
    /// Radial: a pin beyond the x-axis handle — drags the rotation.
    case radialRotate

    /// Screen-reader name for the handle.
    public var accessibilityName: String {
        switch self {
        case .linearStart:   return "gradient start"
        case .linearEnd:     return "gradient end"
        case .linearBody:    return "gradient"
        case .radialCenter:  return "center"
        case .radialRadiusX: return "horizontal radius"
        case .radialRadiusY: return "vertical radius"
        case .radialRotate:  return "rotation"
        }
    }
}

/// Full-frame normalized mask coordinates ↔ canvas points.
public struct MaskCanvasMap: Equatable, Sendable {
    public let footprint: CropGeometry.Footprint
    /// Crop-normalized → full-frame normalized (identity when uncropped).
    public let cropToFull: MaskAffine
    /// Full-frame normalized → crop-normalized.
    public let fullToCrop: MaskAffine

    public init(footprint: CropGeometry.Footprint, crop: Crop, nativeSize: CGSize) {
        self.footprint = footprint
        let forward = MaskAffine.cropToFullFrame(crop, nativeSize: nativeSize)
        self.cropToFull = forward
        self.fullToCrop = forward.inverted() ?? .identity
    }

    /// A full-frame normalized point → canvas point.
    public func toScreen(_ p: MaskPoint) -> CGPoint {
        let q = fullToCrop.apply(p)
        return CGPoint(x: footprint.left + q.x * footprint.width,
                       y: footprint.top + q.y * footprint.height)
    }

    /// A canvas point → full-frame normalized point, clamped to the frame.
    public func fromScreen(_ px: CGPoint) -> MaskPoint {
        let u = footprint.width > 0 ? (Double(px.x) - footprint.left) / footprint.width : 0
        let v = footprint.height > 0 ? (Double(px.y) - footprint.top) / footprint.height : 0
        let p = cropToFull.apply(MaskPoint(x: u, y: v))
        return MaskPoint(x: min(1, max(0, p.x)), y: min(1, max(0, p.y)))
    }
}

public enum MaskGeometry {
    /// Smallest half-axis a radius handle can drag to, in normalized units.
    public static let minimumRadius: Double = 0.01
    /// Where the rotation pin sits along the local x axis, as a multiple of `rx`.
    public static let rotateHandleFactor: Double = 1.3

    // MARK: - Defaults

    /// A fresh linear mask: a top→middle vertical gradient at Lightroom's
    /// default feather.
    public static func defaultLinear() -> LocalMask {
        .linear(start: MaskPoint(x: 0.5, y: 0.15), end: MaskPoint(x: 0.5, y: 0.55), feather: 0.5)
    }

    /// A fresh radial mask centered on the frame. `imageAspect` (width /
    /// height) pre-corrects the normalized radii so the ellipse reads as a
    /// circle on screen — the evaluator itself is aspect-agnostic.
    public static func defaultRadial(imageAspect: Double) -> LocalMask {
        let aspect = imageAspect.isFinite && imageAspect > 0 ? imageAspect : 1
        return .radial(
            center: MaskPoint(x: 0.5, y: 0.5),
            radii: MaskPoint(x: 0.25, y: 0.25 * aspect),
            angle: 0, feather: 0.5, invert: false)
    }

    // MARK: - Handles

    /// Every handle of `mask` with its full-frame normalized position.
    public static func handles(for mask: LocalMask) -> [(handle: MaskHandle, point: MaskPoint)] {
        switch mask {
        case .linear(let start, let end, _):
            return [
                (.linearStart, start),
                (.linearEnd, end),
                (.linearBody, MaskPoint(x: (start.x + end.x) / 2, y: (start.y + end.y) / 2)),
            ]
        case .radial(let center, let radii, let angle, _, _):
            let cosA = cos(angle)
            let sinA = sin(angle)
            return [
                (.radialCenter, center),
                (.radialRadiusX, MaskPoint(x: center.x + radii.x * cosA, y: center.y + radii.x * sinA)),
                (.radialRadiusY, MaskPoint(x: center.x - radii.y * sinA, y: center.y + radii.y * cosA)),
                (.radialRotate, MaskPoint(
                    x: center.x + radii.x * rotateHandleFactor * cosA,
                    y: center.y + radii.x * rotateHandleFactor * sinA)),
            ]
        }
    }

    /// Points along the ellipse boundary in full-frame normalized space —
    /// the overlay maps each through `MaskCanvasMap.toScreen` so a crop or
    /// straighten distorts the drawn outline exactly as it distorts the
    /// rendered mask.
    public static func ellipseOutline(
        center: MaskPoint, radii: MaskPoint, angle: Double, samples: Int = 72
    ) -> [MaskPoint] {
        let cosA = cos(angle)
        let sinA = sin(angle)
        return (0..<max(samples, 3)).map { i in
            let phi = Double(i) / Double(max(samples, 3)) * 2 * .pi
            let lx = radii.x * cos(phi)
            let ly = radii.y * sin(phi)
            return MaskPoint(x: center.x + lx * cosA - ly * sinA, y: center.y + lx * sinA + ly * cosA)
        }
    }

    /// The handle under `px`, within `tolerance` points, or nil. Endpoint
    /// handles win over the body/center so a gradient whose ends sit near its
    /// midpoint stays resizable.
    public static func hitTest(
        _ px: CGPoint, mask: LocalMask, map: MaskCanvasMap, tolerance: Double
    ) -> MaskHandle? {
        let candidates = handles(for: mask)
        let precedence: [MaskHandle] = [
            .linearStart, .linearEnd, .radialRotate, .radialRadiusX, .radialRadiusY,
            .radialCenter, .linearBody,
        ]
        return precedence.first { handle in
            guard let entry = candidates.first(where: { $0.handle == handle }) else { return false }
            let s = map.toScreen(entry.point)
            return hypot(Double(s.x - px.x), Double(s.y - px.y)) <= tolerance
        }
    }

    // MARK: - Drag

    /// `startMask` with `handle` dragged to `point` (full-frame normalized).
    /// `anchor` is where the drag began, for the translating handles.
    public static func dragged(
        _ startMask: LocalMask, handle: MaskHandle, to point: MaskPoint, from anchor: MaskPoint
    ) -> LocalMask {
        switch (startMask, handle) {
        case (.linear(_, let end, let feather), .linearStart):
            return .linear(start: point, end: end, feather: feather)
        case (.linear(let start, _, let feather), .linearEnd):
            return .linear(start: start, end: point, feather: feather)
        case (.linear(let start, let end, let feather), .linearBody):
            let dx = point.x - anchor.x
            let dy = point.y - anchor.y
            return .linear(
                start: MaskPoint(x: start.x + dx, y: start.y + dy),
                end: MaskPoint(x: end.x + dx, y: end.y + dy),
                feather: feather)
        case (.radial(_, let radii, let angle, let feather, let invert), .radialCenter):
            return .radial(center: point, radii: radii, angle: angle, feather: feather, invert: invert)
        case (.radial(let center, let radii, let angle, let feather, let invert), .radialRadiusX):
            let along = (point.x - center.x) * cos(angle) + (point.y - center.y) * sin(angle)
            return .radial(
                center: center, radii: MaskPoint(x: max(minimumRadius, abs(along)), y: radii.y),
                angle: angle, feather: feather, invert: invert)
        case (.radial(let center, let radii, let angle, let feather, let invert), .radialRadiusY):
            let along = -(point.x - center.x) * sin(angle) + (point.y - center.y) * cos(angle)
            return .radial(
                center: center, radii: MaskPoint(x: radii.x, y: max(minimumRadius, abs(along))),
                angle: angle, feather: feather, invert: invert)
        case (.radial(let center, let radii, _, let feather, let invert), .radialRotate):
            return .radial(
                center: center, radii: radii,
                angle: atan2(point.y - center.y, point.x - center.x),
                feather: feather, invert: invert)
        default:
            // A handle that doesn't belong to this shape — nothing to move.
            return startMask
        }
    }
}
