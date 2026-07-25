// ColorWheelView.swift — one hue/saturation colour wheel for the Color
// Grading panel (#275).
//
// SwiftUI gesture host over the pure geometry in `MapleCore.ColorWheelGeometry`
// — mirrors how `CropOverlay` hosts `CropGeometry`: no puck-position ↔
// (hue, saturation) math lives in this file, only layout + gesture wiring.
//
// Visual: an `AngularGradient` hue ring (full saturation/brightness) under a
// centre-out white→transparent `RadialGradient` (full white at the centre
// reads as "no tint", fading to the ring's hue toward the rim) plus a
// draggable puck tinted to the current (hue, saturation).
//
// Gesture: `DragGesture(minimumDistance: 0)` writes (hue, saturation) into
// the caller's bindings on every change, committing ONE undo snapshot at
// gesture START (before the first mutation) — mirrors `CropOverlay`'s
// `DragState.committed` guard and `DragBar`'s "commit-at-gesture-start"
// convention, so `beginEdit()` (which snapshots the CURRENT model) captures
// the pre-drag state.
//
// Accessibility: arrow keys nudge hue (left/right) and saturation (up/down)
// via `ColorWheelGeometry.nudge`, each commit-and-mutate step mirroring the
// drag gesture's undo boundary. `accessibilityAdjustableAction` gives
// VoiceOver users the same nudge on a horizontal swipe.

import SwiftUI
import MapleCore

struct ColorWheelView: View {
    /// Accessibility label, e.g. "Shadows colour wheel".
    let label: String
    @Binding var hue: Double
    @Binding var saturation: Double
    /// Called once per gesture / per discrete nudge, BEFORE the mutation —
    /// the caller's undo snapshot boundary (typically `{ state.commit() }`).
    let onCommit: () -> Void

    /// True once this gesture has already fired `onCommit()` — reset on
    /// `.onEnded` so the NEXT drag commits again exactly once.
    @State private var hasCommittedThisDrag = false
    @FocusState private var isFocused: Bool

    private var puckColor: Color {
        Color(hue: hue / 360.0, saturation: saturation / 100.0, brightness: 1.0)
    }

    var body: some View {
        GeometryReader { geo in
            let side = min(geo.size.width, geo.size.height)
            let position = ColorWheelGeometry.position(hue: hue, saturation: saturation)

            ZStack {
                hueRing
                saturationFade(side: side)
                puck(side: side, position: position)
            }
            .frame(width: side, height: side)
            .contentShape(Circle())
            .gesture(dragGesture(side: side))
            .focusable()
            .focused($isFocused)
            .onKeyPress(.leftArrow)  { nudge(dx: -1, dy: 0); return .handled }
            .onKeyPress(.rightArrow) { nudge(dx: 1, dy: 0); return .handled }
            .onKeyPress(.upArrow)    { nudge(dx: 0, dy: 1); return .handled }
            .onKeyPress(.downArrow)  { nudge(dx: 0, dy: -1); return .handled }
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(
            "Hue \(Int(hue.rounded())) degrees, saturation \(Int(saturation.rounded())) percent"
        )
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: nudge(dx: 1, dy: 0)
            case .decrement: nudge(dx: -1, dy: 0)
            @unknown default: break
            }
        }
    }

    // MARK: - Layers

    /// `AngularGradient` sweeps CLOCKWISE from 3 o'clock, but
    /// `ColorWheelGeometry` reads the puck angle COUNTER-clockwise from the
    /// same origin (it negates `dy` for SwiftUI's downward y). Feeding the
    /// stops in DESCENDING hue order flips the visual sweep to match, so the
    /// colour the user drags onto is the hue the model receives — without it,
    /// the bottom of the wheel paints green while the geometry there reports
    /// 270° (purple). The web wheel gets the same result from
    /// `conic-gradient(from -90deg, …)` with descending stops.
    private var hueRing: some View {
        let stops = stride(from: 0.0, through: 360.0, by: 30.0).map {
            Color(hue: (360.0 - $0) / 360.0, saturation: 1, brightness: 1)
        }
        return AngularGradient(gradient: Gradient(colors: stops), center: .center)
            .clipShape(Circle())
    }

    /// `RadialGradient`'s radii are absolute points, not frame-relative,
    /// so `side` (the wheel's rendered diameter) is threaded in to make
    /// the fade reach exactly the rim regardless of layout size.
    private func saturationFade(side: CGFloat) -> some View {
        RadialGradient(
            colors: [.white, .white.opacity(0)],
            center: .center,
            startRadius: 0,
            endRadius: side / 2
        )
        .clipShape(Circle())
    }

    private func puck(side: CGFloat, position: ColorWheelGeometry.Position) -> some View {
        let diameter: CGFloat = 18
        return Circle()
            .fill(puckColor)
            .frame(width: diameter, height: diameter)
            .overlay(Circle().stroke(Color.white, lineWidth: 2))
            .shadow(color: .black.opacity(0.45), radius: 1.5, x: 0, y: 0.5)
            .position(x: CGFloat(position.x) * side, y: CGFloat(position.y) * side)
    }

    // MARK: - Gesture

    private func dragGesture(side: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                if !hasCommittedThisDrag {
                    onCommit()
                    hasCommittedThisDrag = true
                }
                guard side > 0 else { return }
                let position = ColorWheelGeometry.Position(
                    x: Double(value.location.x / side),
                    y: Double(value.location.y / side)
                )
                let result = ColorWheelGeometry.hueSaturation(at: position)
                hue = result.hue
                saturation = result.saturation
            }
            .onEnded { _ in
                hasCommittedThisDrag = false
            }
    }

    // MARK: - Keyboard nudge

    private func nudge(dx: Int, dy: Int) {
        onCommit()
        let result = ColorWheelGeometry.nudge(hue: hue, saturation: saturation, dx: dx, dy: dy)
        hue = result.hue
        saturation = result.saturation
    }
}
