// RetouchOverlay.swift — the clone / heal brush canvas overlay (#3409), the
// repair sibling of `CropOverlay`.
//
// Draws every spot's destination disc; the selected spot additionally shows
// its source disc and a line joining the two, which is Lightroom's own
// reading of "these pixels came from there". A press on empty canvas places
// a spot with the panel's current brush and immediately drags its source, so
// one gesture both places and aims the repair; a press on a disc grabs that
// handle. Each gesture is one `repair`-class `EditTransaction`.
//
// Placement follows the canvas the way `MaskOverlay` does (#3354): the spot
// list is in full-frame normalised coordinates, so the whole overlay is laid
// out inside `MaskOverlayGeometry.fullFrameRect` and rotated by the
// straighten angle about that rect's centre. The pure math — including the
// inverse transform the drag needs — is `RetouchOverlayGeometry`.

import MapleCore
import SwiftUI

struct RetouchOverlay: View {
    @Bindable var state: EditorState

    @State private var dragHandle: RetouchHandle?
    @State private var dragStart: RetouchSpot?
    @State private var dragAnchor: RetouchPoint?

    private var retouch: RetouchSession { state.retouch }

    var body: some View {
        GeometryReader { geo in
            if let frame = state.zoom.displayFrameInPoints,
                let full = MaskOverlayGeometry.fullFrameRect(
                    containerSize: geo.size, displayFrame: frame,
                    panOffset: state.zoom.panOffset, crop: state.session.model.crop)
            {
                ZStack {
                    // The straighten angle rotates the frame about its
                    // centre before the crop is cut; the spots are
                    // full-frame, so `screenPoint` rotates each one the same
                    // way. Rotating the placed positions rather than the
                    // container keeps the rotation anchored on the FRAME's
                    // centre, which is not the container's whenever the
                    // canvas is panned or zoomed off fit.
                    discs(in: full)
                    Color.clear
                        .contentShape(Rectangle())
                        .gesture(dragGesture(full: full))
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Heal overlay")
                .accessibilityValue(overlayDescription)
                .accessibilityIdentifier("editor-retouch-overlay")
            }
        }
    }

    private var overlayDescription: String {
        let count = retouch.spots.count
        if count == 0 { return "No repair spots — tap the image to place one" }
        guard let spot = retouch.selected else {
            return "\(count) repair spot\(count == 1 ? "" : "s")"
        }
        return "\(spot.kind == .clone ? "Clone" : "Heal") spot selected of \(count)"
    }

    @ViewBuilder
    private func discs(in full: CGRect) -> some View {
        ZStack(alignment: .topLeading) {
            if let spot = retouch.selected {
                linkLine(spot, in: full)
                disc(
                    at: spot.source, radius: spot.radius, in: full,
                    style: .source, label: "Source")
            }
            ForEach(retouch.spots) { spot in
                disc(
                    at: spot.center, radius: spot.radius, in: full,
                    style: spot.id == retouch.selectedSpotID ? .selected : .plain,
                    label: spot.kind == .clone ? "Clone destination" : "Heal destination")
            }
        }
        .allowsHitTesting(false)
    }

    private enum DiscStyle { case plain, selected, source }

    private func disc(
        at point: RetouchPoint, radius: Double, in full: CGRect, style: DiscStyle, label: String
    ) -> some View {
        let centre = RetouchOverlayGeometry.screenPoint(
            point, fullFrame: full, angleDegrees: state.session.model.crop.angle)
        let r = RetouchOverlayGeometry.radiusPoints(radius, fullFrame: full)
        return Circle()
            .stroke(strokeColor(style), style: strokeStyle(style))
            .frame(width: r * 2, height: r * 2)
            .position(centre)
            .accessibilityLabel("Heal handle: \(label)")
    }

    private func strokeColor(_ style: DiscStyle) -> Color {
        switch style {
        case .plain: return .white.opacity(0.75)
        case .selected: return .white.opacity(0.95)
        case .source: return ProTokens.accent
        }
    }

    private func strokeStyle(_ style: DiscStyle) -> StrokeStyle {
        switch style {
        case .plain: return StrokeStyle(lineWidth: 1, dash: [4, 3])
        case .selected, .source: return StrokeStyle(lineWidth: 1.5)
        }
    }

    private func linkLine(_ spot: RetouchSpot, in full: CGRect) -> some View {
        let angle = state.session.model.crop.angle
        let a = RetouchOverlayGeometry.screenPoint(
            spot.source, fullFrame: full, angleDegrees: angle)
        let b = RetouchOverlayGeometry.screenPoint(
            spot.center, fullFrame: full, angleDegrees: angle)
        return Path { path in
            path.move(to: a)
            path.addLine(to: b)
        }
        .stroke(ProTokens.accent, style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
    }

    // MARK: - Gesture

    private func dragGesture(full: CGRect) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                let point = RetouchOverlayGeometry.normalizedPoint(
                    from: value.location, fullFrame: full,
                    angleDegrees: state.session.model.crop.angle)
                if dragHandle == nil { beginDrag(at: point, full: full) }
                guard let handle = dragHandle, let start = dragStart, let anchor = dragAnchor
                else { return }
                retouch.setShape(
                    RetouchOverlayGeometry.drag(
                        start, handle: handle, to: point, anchor: anchor))
            }
            .onEnded { _ in
                dragHandle = nil
                dragStart = nil
                dragAnchor = nil
                retouch.endGesture()
            }
    }

    /// First event of a press: grab an existing handle, or place a new spot
    /// and start dragging its source.
    private func beginDrag(at point: RetouchPoint, full: CGRect) {
        if let hit = hitTest(point, full: full) {
            retouch.select(hit.spot.id)
            dragHandle = hit.handle
            dragStart = hit.spot
            dragAnchor = point
            return
        }
        let placed = retouch.place(at: point)
        dragHandle = .source
        dragStart = placed
        dragAnchor = placed.source
    }

    /// The topmost spot and handle under `point`. The selected spot is tested
    /// first because only it draws a source disc; the rest are tested back to
    /// front, so a spot placed on top of another is the one you grab.
    private func hitTest(
        _ point: RetouchPoint, full: CGRect
    ) -> (spot: RetouchSpot, handle: RetouchHandle)? {
        if let selected = retouch.selected,
            let handle = RetouchOverlayGeometry.hitTest(
                point, spot: selected, fullFrame: full)
        {
            return (selected, handle)
        }
        for spot in retouch.spots.reversed() where spot.id != retouch.selectedSpotID {
            // An unselected spot draws no source disc, so only its
            // destination is grabbable.
            if RetouchOverlayGeometry.contains(
                point, target: spot.center, spot: spot, fullFrame: full)
            {
                return (spot, .destination)
            }
        }
        return nil
    }
}
