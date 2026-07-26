// ToneCurvePlot.swift — the square point-curve canvas (#367).
//
// Drawn with `Canvas` (grid, identity diagonal, the curve itself) and an
// overlaid stack of real `Circle` views for the control points. The split is
// deliberate: `Canvas` repaints the curve cheaply on every drag sample, but a
// shape drawn INSIDE it is invisible to VoiceOver, and the curve editor is the
// one control in the editor where "the third point from the left" is the only
// way to say what you are grabbing. There are never more than a handful of
// knots, so hoisting them out as views costs nothing and buys each one a real
// accessibility label plus keyboard focus.
//
// The view is purely presentational: it takes a point list and hands edited
// lists back through `onChange` / `onCommit`. Every editing RULE — endpoint
// pinning, the neighbour gap, identity collapse — lives in
// `ToneCurveEditing` in MapleCore, so the SwiftUI and Angular widgets
// enforce the same invariants and both are unit-tested without a UI host.
//
// ## Render-tick budget
//
// `onChange` writes `session.model`, which re-runs the live wgpu chain. That
// is affordable at pointer rate ONLY because `RawCoreBridge.stripAppleGPUStages`
// strips the four `toneCurve*` fields (#367), so a curve edit leaves the
// decode-cache key untouched and never triggers a re-decode. It is still not
// free, so the drag paints from local state and forwards the model write at
// most once per display frame; the final position always writes on release.

import MapleCore
import SwiftUI

struct ToneCurvePlot: View {
    /// The committed point list for the active channel (empty = identity).
    let points: [ToneCurvePoint]
    /// Stroke colour for this channel's curve.
    let stroke: Color
    /// Human name of the active channel, used in accessibility labels.
    let channelName: String
    /// The live session, drawn as a ghost histogram behind the curve.
    let session: EditSession?
    /// Called with a new point list on every accepted edit.
    let onChange: ([ToneCurvePoint]) -> Void
    /// Called once per gesture, at release, to close an undo boundary.
    let onCommit: () -> Void

    /// Knot hit radius, in authoring-domain units (≈ 8pt on a 220pt plot).
    private static let hitRadius = 0.05
    /// Minimum spacing between forwarded model writes — one display frame.
    private static let writeInterval: CFTimeInterval = 1.0 / 60.0
    /// Vertical nudge per arrow-key press, in authoring-domain units.
    private static let keyStep = 1.0 / 64.0

    @State private var dragIndex: Int?
    @State private var dragPoints: [ToneCurvePoint]?
    @State private var lastWrite: CFTimeInterval = 0
    @State private var pendingWrite: [ToneCurvePoint]?

    /// What the plot shows: the in-flight drag list when one is live, else
    /// the committed model value.
    private var shownPoints: [ToneCurvePoint] { dragPoints ?? points }

    /// The knots as the overlay draws them — always materialised, so an
    /// identity curve still shows its two corner anchors to grab.
    private var knots: [ToneCurvePoint] { ToneCurveEditing.materialize(shownPoints) }

    var body: some View {
        GeometryReader { geo in
            let size = min(geo.size.width, geo.size.height)
            ZStack {
                histogramBackdrop
                Canvas { context, canvasSize in
                    draw(context: context, size: canvasSize)
                }
                knotOverlay(size: size)
            }
            .frame(width: size, height: size)
            .background(ProTokens.canvasAlt)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(ProTokens.border, lineWidth: 0.5)
            )
            .contentShape(Rectangle())
            .gesture(dragGesture(size: size))
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("editor-tone-curve-plot")
    }

    // MARK: - Backdrop

    /// The same live histogram the pill header shows, dimmed to a ghost so
    /// the curve reads on top of it. Reusing `MiniHistogram` keeps the
    /// debounced, off-render-path loader in one place.
    private var histogramBackdrop: some View {
        MiniHistogram(session: session) { Color.clear }
            .opacity(0.22)
            .allowsHitTesting(false)
    }

    // MARK: - Canvas drawing

    private func draw(context: GraphicsContext, size: CGSize) {
        let w = size.width
        let h = size.height

        // Quarter grid.
        var grid = Path()
        for fraction in [0.25, 0.5, 0.75] {
            grid.move(to: CGPoint(x: w * fraction, y: 0))
            grid.addLine(to: CGPoint(x: w * fraction, y: h))
            grid.move(to: CGPoint(x: 0, y: h * fraction))
            grid.addLine(to: CGPoint(x: w, y: h * fraction))
        }
        context.stroke(grid, with: .color(.white.opacity(0.08)), lineWidth: 0.5)

        // Identity diagonal.
        var identity = Path()
        identity.move(to: CGPoint(x: 0, y: h))
        identity.addLine(to: CGPoint(x: w, y: 0))
        context.stroke(
            identity,
            with: .color(.white.opacity(0.20)),
            style: StrokeStyle(lineWidth: 0.75, dash: [3, 4])
        )

        // The curve. `ToneCurveMath.sample` is the port of the pipeline's
        // Fritsch–Carlson evaluator, so this is the shape that will render.
        let samples = ToneCurveMath.sample(shownPoints)
        guard let first = samples.first else { return }
        var curve = Path()
        curve.move(to: point(first, in: size))
        for sample in samples.dropFirst() {
            curve.addLine(to: point(sample, in: size))
        }
        context.stroke(
            curve,
            with: .color(stroke),
            style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round)
        )
    }

    /// Authoring domain → view space. This is the ONE y flip; nothing else
    /// in the file inverts.
    private func point(_ p: ToneCurvePoint, in size: CGSize) -> CGPoint {
        CGPoint(x: p.x * size.width, y: (1 - p.y) * size.height)
    }

    // MARK: - Knot overlay

    private func knotOverlay(size: CGFloat) -> some View {
        let list = knots
        let count = list.count
        return ZStack(alignment: .topLeading) {
            ForEach(Array(list.enumerated()), id: \.offset) { index, knot in
                ToneCurveKnotMarker(
                    center: point(knot, in: CGSize(width: size, height: size)),
                    isPinned: index == 0 || index == count - 1,
                    tint: stroke,
                    label: knotLabel(index: index, count: count, isPinned: index == 0 || index == count - 1),
                    value: "\(Int((knot.y * 100).rounded()))",
                    identifier: "editor-tone-curve-knot-\(index)",
                    onAdjust: { direction in adjust(index: index, direction: direction) }
                )
            }
        }
        .frame(width: size, height: size, alignment: .topLeading)
        .allowsHitTesting(false)
    }

    private func knotLabel(index: Int, count: Int, isPinned: Bool) -> String {
        let base = "\(channelName) curve point \(index + 1) of \(count)"
        return isPinned ? base + ", endpoint" : base
    }

    /// VoiceOver's increment / decrement on a focused knot — the keyboard
    /// equivalent of dragging it up or down.
    private func adjust(index: Int, direction: AccessibilityAdjustmentDirection) {
        let list = ToneCurveEditing.materialize(shownPoints)
        guard index >= 0, index < list.count else { return }
        let delta = direction == .increment ? Self.keyStep : -Self.keyStep
        let moved = ToneCurveEditing.move(
            shownPoints, index: index, x: list[index].x, y: list[index].y + delta
        )
        onCommit()
        onChange(moved)
    }

    // MARK: - Drag

    private func dragGesture(size: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                let pos = authoring(value.location, size: size)
                if dragIndex == nil {
                    beginDrag(at: pos)
                } else {
                    continueDrag(to: pos)
                }
            }
            .onEnded { _ in endDrag() }
    }

    /// Grab the knot under the finger, or insert one there and grab that.
    private func beginDrag(at pos: (x: Double, y: Double)) {
        let existing = ToneCurveEditing.hitTest(
            points, x: pos.x, y: pos.y, radius: Self.hitRadius
        )
        let next = existing != nil
            ? ToneCurveEditing.materialize(points)
            : ToneCurveEditing.insert(points, x: pos.x, y: pos.y)
        guard let index = existing
            ?? ToneCurveEditing.hitTest(next, x: pos.x, y: pos.y, radius: Self.hitRadius)
        else { return }

        // Snapshot for undo at the START of the gesture, so one drag is one
        // undo entry no matter how many writes it forwards.
        onCommit()
        dragIndex = index
        dragPoints = next
        lastWrite = 0
        forward(next)
    }

    private func continueDrag(to pos: (x: Double, y: Double)) {
        guard let index = dragIndex else { return }
        let next = ToneCurveEditing.move(shownPoints, index: index, x: pos.x, y: pos.y)
        // Paint immediately; forward to the model at most once per frame.
        dragPoints = next
        forward(next)
    }

    private func endDrag() {
        // Flush whatever the frame gate held back, so the committed curve is
        // exactly where the finger was lifted.
        if let pending = pendingWrite {
            onChange(pending)
            pendingWrite = nil
        }
        dragIndex = nil
        dragPoints = nil
    }

    /// Forward to the model, rate-limited to one write per display frame.
    private func forward(_ next: [ToneCurvePoint]) {
        let now = CACurrentMediaTime()
        guard now - lastWrite >= Self.writeInterval else {
            pendingWrite = next
            return
        }
        lastWrite = now
        pendingWrite = nil
        onChange(next)
    }

    /// View space → authoring domain.
    private func authoring(_ location: CGPoint, size: CGFloat) -> (x: Double, y: Double) {
        guard size > 0 else { return (0, 0) }
        return (x: location.x / size, y: 1 - location.y / size)
    }
}

// MARK: - ToneCurveKnotMarker

/// One control point, hoisted out of the `Canvas` so VoiceOver can reach it.
/// Split into its own view for the same reason the other editor markers are:
/// the modifier chain (fill + overlay stroke + position + four accessibility
/// modifiers) exceeds the Swift expression type-checker's budget when it is
/// inlined into a `ForEach` body.
private struct ToneCurveKnotMarker: View {
    let center: CGPoint
    let isPinned: Bool
    let tint: Color
    let label: String
    let value: String
    let identifier: String
    let onAdjust: (AccessibilityAdjustmentDirection) -> Void

    private var strokeColor: Color { isPinned ? Color.white.opacity(0.30) : tint }
    private var strokeWidth: CGFloat { isPinned ? 1 : 1.5 }

    var body: some View {
        Circle()
            .fill(ProTokens.text)
            .overlay(Circle().stroke(strokeColor, lineWidth: strokeWidth))
            .frame(width: 9, height: 9)
            .position(center)
            .accessibilityElement()
            .accessibilityLabel(label)
            .accessibilityValue(value)
            .accessibilityIdentifier(identifier)
            .accessibilityAdjustableAction(onAdjust)
    }
}
