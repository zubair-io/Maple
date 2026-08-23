// MuiWhiteboardCanvasMath.swift — pure stroke math for `MuiWhiteboardCanvas`.
// Mirrors the web reference's eraser hit-test: a stroke is erased once any
// of its points falls within `ERASER_HIT_RADIUS` of the eraser's current
// position (mui-whiteboard-canvas.component.ts).

import CoreGraphics
import Foundation

public struct MuiWhiteboardStroke: Identifiable, Sendable {
    public let id: String
    public var points: [CGPoint]

    public init(id: String = UUID().uuidString, points: [CGPoint] = []) {
        self.id = id
        self.points = points
    }
}

enum MuiWhiteboardCanvasMath {
    static let eraserHitRadius: CGFloat = 12

    /// Whether `stroke` should be erased for an eraser currently at
    /// `point` — true once any of the stroke's own points falls within
    /// `radius`.
    static func strokeHit(_ stroke: MuiWhiteboardStroke, at point: CGPoint, radius: CGFloat = eraserHitRadius) -> Bool {
        stroke.points.contains { strokePoint in
            let dx = strokePoint.x - point.x
            let dy = strokePoint.y - point.y
            return (dx * dx + dy * dy).squareRoot() <= radius
        }
    }

    /// The stroke list after erasing at `point` — every stroke NOT hit
    /// survives, same "erase removes strokes, never adds one" contract as
    /// the web reference. Public + static so this is unit-testable without
    /// rendering a view.
    static func erasing(_ strokes: [MuiWhiteboardStroke], at point: CGPoint) -> [MuiWhiteboardStroke] {
        strokes.filter { !strokeHit($0, at: point) }
    }
}
