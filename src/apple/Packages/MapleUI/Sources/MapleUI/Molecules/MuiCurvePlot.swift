// MuiCurvePlot.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.6; a plot primitive). A draggable control-point curve (e.g. a tone
// curve editor): each point is `0...1` normalized, drawn as a smoothed
// line via SwiftUI `Canvas`, dragged with a `DragGesture`, and nudged by
// arrow keys once a point's been picked up. See `MuiCurvePlotMath` for the
// point/canvas math and the monotone midpoint-quadratic smoothing this
// mirrors from the web reference.

import SwiftUI

public struct MuiCurvePoint: Equatable, Sendable {
    /// `[0, 1]`, right-positive.
    public var x: Double
    /// `[0, 1]`, up-positive.
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }

    public static let defaultPoints: [MuiCurvePoint] = [
        MuiCurvePoint(x: 0, y: 0),
        MuiCurvePoint(x: 0.5, y: 0.5),
        MuiCurvePoint(x: 1, y: 1),
    ]
}

public struct MuiCurvePlot: View {
    @Binding public var points: [MuiCurvePoint]
    public let width: CGFloat
    public let height: CGFloat
    public let accessibilityLabel: String

    @State private var activeIndex: Int?

    public init(
        points: Binding<[MuiCurvePoint]>,
        width: CGFloat = 160,
        height: CGFloat = 120,
        accessibilityLabel: String = "Curve plot"
    ) {
        self._points = points
        self.width = width
        self.height = height
        self.accessibilityLabel = accessibilityLabel
    }

    public var body: some View {
        Canvas { context, size in
            var frame = Path()
            frame.addRect(CGRect(origin: .zero, size: size).insetBy(dx: 0.5, dy: 0.5))
            context.stroke(frame, with: .color(MuiTokens.border), lineWidth: 1)

            let sorted = MuiCurvePlotMath.sortedCanvasPoints(points, width: size.width, height: size.height)
            if sorted.count >= 2 {
                var curve = Path()
                curve.move(to: sorted[0])
                for segment in MuiCurvePlotMath.segments(forSortedCanvasPoints: sorted) {
                    curve.addQuadCurve(to: segment.end, control: segment.control)
                }
                curve.addLine(to: sorted.last!)
                context.stroke(curve, with: .color(MuiTokens.primary), lineWidth: 2)
            }

            for (index, point) in points.enumerated() {
                let canvasPoint = MuiCurvePlotMath.toCanvasPoint(point, width: size.width, height: size.height)
                let radius: CGFloat = index == activeIndex ? 4 : 3
                let dot = Path(ellipseIn: CGRect(x: canvasPoint.x - radius, y: canvasPoint.y - radius, width: radius * 2, height: radius * 2))
                context.fill(dot, with: .color(MuiTokens.primary))
            }
        }
        .frame(width: width, height: height)
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { drag in
                    let index = activeIndex ?? MuiCurvePlotMath.hitTest(points, location: drag.location, width: width, height: height)
                    guard let index, points.indices.contains(index) else { return }
                    activeIndex = index
                    points[index] = MuiCurvePlotMath.fromCanvasPoint(drag.location, width: width, height: height)
                }
        )
        #if os(macOS)
        .focusable()
        .onKeyPress(.upArrow) { nudge(dx: 0, dy: MuiCurvePlotMath.nudgeStep); return .handled }
        .onKeyPress(.downArrow) { nudge(dx: 0, dy: -MuiCurvePlotMath.nudgeStep); return .handled }
        .onKeyPress(.rightArrow) { nudge(dx: MuiCurvePlotMath.nudgeStep, dy: 0); return .handled }
        .onKeyPress(.leftArrow) { nudge(dx: -MuiCurvePlotMath.nudgeStep, dy: 0); return .handled }
        #endif
        .accessibilityElement()
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue("\(points.count) control points")
    }

    private func nudge(dx: Double, dy: Double) {
        guard let activeIndex, points.indices.contains(activeIndex) else { return }
        points[activeIndex] = MuiCurvePlotMath.nudged(points[activeIndex], dx: dx, dy: dy)
    }
}

#Preview("MuiCurvePlot") {
    struct Demo: View {
        @State private var points: [MuiCurvePoint] = [
            MuiCurvePoint(x: 0, y: 0.1),
            MuiCurvePoint(x: 0.3, y: 0.5),
            MuiCurvePoint(x: 0.7, y: 0.6),
            MuiCurvePoint(x: 1, y: 0.95),
        ]

        var body: some View {
            MuiCurvePlot(points: $points)
        }
    }
    return Demo()
        .padding()
        .background(MuiTokens.bg)
}
