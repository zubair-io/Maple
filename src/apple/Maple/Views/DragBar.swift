// DragBar.swift — responsive-program S5b (#625).
//
// The centerpiece UX primitive. 30pt tall, 24pt horizontal padding, 21
// ticks at 5% increments, 2pt × 22pt accent marker. Drag inside the bar
// at 1:1; the editor canvas overlay routes its own drags here at 0.5:1
// via `applyDragDelta(_:sensitivity:)`. Double-tap to reset to 0;
// long-press the marker to engage fine mode (0.25:1) for the next drag.
// Haptics on zero-cross, extreme, reset, switch.
//
// Pure math lives in `MapleCore.DragBarMath` so the same value↔pixel
// rules can be re-used by the canvas overlay's drag handler and tested
// without a SwiftUI dependency.
//
// Spec: docs/design/responsive-program/s5-editor.md §3.

import SwiftUI
import MapleCore
#if canImport(UIKit)
import UIKit
#endif

struct DragBar: View {
    @Bindable var state: EditorState

    /// Backing value for the marker — the armed (tool, subParam) pair's
    /// value on the internal `[-100, +100]` scale. `EditorState` owns
    /// the display↔internal resolution so the marker tracks the armed
    /// sub-param's mapping on multi-param tools (#1108).
    var internalValue: Double {
        state.armedInternalValue
    }

    /// Track the gesture's start value so per-frame deltas can apply on
    /// top of the snapshot at touch-down without accumulating drift.
    @State private var dragStartValue: Double?
    /// Last-applied internal value so haptic predicates can fire on
    /// per-update transitions.
    @State private var lastValue: Double = 0

    var body: some View {
        GeometryReader { proxy in
            let barWidth = proxy.size.width
            ZStack(alignment: .leading) {
                // 1pt baseline rule
                Rectangle()
                    .fill(MapleTokens.border)
                    .frame(height: 1)
                    .frame(maxHeight: .infinity, alignment: .center)

                // 21 ticks
                ForEach(0..<DragBarMath.tickCount, id: \.self) { i in
                    let x = DragBarMath.tickX(forIndex: i, barWidth: barWidth)
                    let h = DragBarMath.tickHeight(forIndex: i)
                    Rectangle()
                        .fill(i == DragBarMath.centerTickIndex
                              ? MapleTokens.borderHi
                              : MapleTokens.border)
                        .frame(width: 1, height: h)
                        .position(x: x, y: proxy.size.height / 2)
                        .accessibilityHidden(true)
                }

                // 2pt × 22pt marker
                let mx = DragBarMath.markerX(forValue: internalValue, barWidth: barWidth)
                Rectangle()
                    .fill(MapleTokens.primary)
                    .frame(width: DragBarMath.markerWidth,
                           height: DragBarMath.markerHeight)
                    .position(x: mx, y: proxy.size.height / 2)
                    .accessibilityLabel("Drag bar marker")
            }
            .contentShape(Rectangle())
            .gesture(makeDragGesture(barWidth: barWidth))
            .onTapGesture(count: 2) { resetTapped() }
            .onLongPressGesture(minimumDuration: 0.5) { engageFineMode() }
            // Presets (#1115) and the gated stubs have no value pipe —
            // without this, the drag gesture's touch-down `state.commit()`
            // would push a junk undo snapshot for a value write the
            // EditorState guards then ignore. Visual is unchanged; only
            // interactivity is gated.
            .allowsHitTesting(state.armedToolAcceptsValueEdits)
        }
        .frame(height: 30)
        .padding(.horizontal, 24)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("editor-drag-bar")
    }

    // MARK: - Gesture

    private func makeDragGesture(barWidth: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { g in
                if dragStartValue == nil {
                    dragStartValue = internalValue
                    lastValue = internalValue
                    state.commit()   // undo snapshot at gesture start
                    // Commit-on-release sub-params (Noise → Deep / Prefilter,
                    // #1153) park their value for the gesture instead of
                    // re-decoding per sample; inert for every other tool.
                    state.beginGesture()
                }
                let sensitivity: DragSensitivity = state.fineMode ? .fine : .bar
                let dv = DragBarMath.valueDelta(
                    forDeltaX: g.translation.width,
                    barWidth: barWidth,
                    sensitivity: sensitivity
                )
                let newV = DragBarMath.clamp((dragStartValue ?? 0) + dv)
                emitHaptics(from: lastValue, to: newV)
                state.setArmedInternalValue(newV)
                lastValue = newV
            }
            .onEnded { _ in
                dragStartValue = nil
                state.fineMode = false
                // Release is the commit point for deferred sub-params.
                state.endGesture()
            }
    }

    private func resetTapped() {
        // Route through resetArmedTool so each tool snaps to its canonical
        // default (e.g. Color NR → 25, Sharpen → 40, Temp → 6500). The old
        // "internal 0" path mapped one-sided tools to their midpoint, not
        // their default. `resetArmedTool` also handles the undo snapshot.
        state.resetArmedTool()
        emitSelectionHaptic()
    }

    private func engageFineMode() {
        state.fineMode = true
        emitSelectionHaptic()
    }

    // MARK: - Haptics

    private func emitHaptics(from a: Double, to b: Double) {
        #if canImport(UIKit) && !os(macOS)
        if DragBarMath.didReachExtreme(from: a, to: b) {
            let gen = UIImpactFeedbackGenerator(style: .medium)
            gen.impactOccurred()
        } else if DragBarMath.didCrossZero(from: a, to: b) {
            let gen = UIImpactFeedbackGenerator(style: .light)
            gen.impactOccurred()
        }
        #endif
    }

    private func emitSelectionHaptic() {
        #if canImport(UIKit) && !os(macOS)
        let gen = UISelectionFeedbackGenerator()
        gen.selectionChanged()
        #endif
    }
}

#if DEBUG
#Preview("DragBar — exposure") {
    let session = EditSession.preview()
    let state = EditorState(session: session)
    return VStack {
        DragBar(state: state)
            .frame(height: 30)
        Text("Value: \(session.model.exposure, specifier: "%.2f")")
            .foregroundStyle(MapleTokens.textMuted)
    }
    .padding()
    .background(MapleTokens.bg)
}
#endif
