// MuiDragBar.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.1). Tick-marked scrub control, built from Text. A self-contained
// design-system re-implementation of the Pro Editor's `DragBar`
// (src/apple/Maple/Views/DragBar.swift) and the web reference's
// `mui-drag-bar` — same click-to-jump + continuous-drag + keyboard-nudge
// contract, but dependency-free and without the app's haptics/fine-mode/
// undo-snapshot integration.

import SwiftUI

public struct MuiDragBar: View {
    public let label: String?
    @Binding public var value: Double
    public let range: ClosedRange<Double>
    public let step: Double
    public let disabled: Bool

    static let tickCount = 21
    static let centerTickIndex = 10

    public init(
        label: String? = nil,
        value: Binding<Double>,
        range: ClosedRange<Double> = -100...100,
        step: Double = 1,
        disabled: Bool = false
    ) {
        self.label = label
        self._value = value
        self.range = range
        self.step = step
        self.disabled = disabled
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let label {
                HStack {
                    MuiText(label, variant: .toolLabel, color: .muted)
                    Spacer()
                    MuiText(Self.valueLabel(value), variant: .body, color: .main)
                }
            }

            GeometryReader { geo in
                let barWidth = geo.size.width
                ZStack(alignment: .leading) {
                    Rectangle()
                        .fill(MuiTokens.border)
                        .frame(height: 1)
                        .frame(maxHeight: .infinity, alignment: .center)

                    ForEach(0..<Self.tickCount, id: \.self) { i in
                        let x = barWidth * CGFloat(i) / CGFloat(Self.tickCount - 1)
                        let emphasized = i == Self.centerTickIndex
                        Rectangle()
                            .fill(emphasized ? MuiTokens.borderHi : MuiTokens.border)
                            .frame(width: 1, height: emphasized ? 14 : 6)
                            .position(x: x, y: 15)
                    }

                    let markerPct = MuiScrubMath.percentInRange(value: value, min: range.lowerBound, max: range.upperBound, fallbackPct: 50) / 100
                    Rectangle()
                        .fill(MuiTokens.primary)
                        .frame(width: 2, height: 22)
                        .position(x: barWidth * markerPct, y: 15)
                }
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { g in
                            guard !disabled else { return }
                            value = Self.valueAtPosition(x: g.location.x, barWidth: barWidth, range: range, step: step)
                        }
                )
            }
            .frame(height: 30)
            .accessibilityElement()
            .accessibilityLabel(label ?? "Drag bar")
            .accessibilityValue(Self.valueLabel(value))
            .accessibilityAdjustableAction { direction in
                guard !disabled else { return }
                switch direction {
                case .increment: value = MuiScrubMath.snap(value + step, step: step, min: range.lowerBound, max: range.upperBound)
                case .decrement: value = MuiScrubMath.snap(value - step, step: step, min: range.lowerBound, max: range.upperBound)
                @unknown default: break
                }
            }
        }
        .opacity(disabled ? 0.45 : 1)
    }

    /// The value at pointer position `x` within a bar of `barWidth` points —
    /// snapped to `step` and clamped to `range`. Public + static so this is
    /// unit-testable without running a gesture.
    public static func valueAtPosition(x: CGFloat, barWidth: CGFloat, range: ClosedRange<Double>, step: Double) -> Double {
        guard barWidth > 0 else { return range.lowerBound }
        let pct = Double(x / barWidth) * 100
        let raw = MuiScrubMath.valueFromPercent(pct, min: range.lowerBound, max: range.upperBound)
        return MuiScrubMath.snap(raw, step: step, min: range.lowerBound, max: range.upperBound)
    }

    private static func valueLabel(_ value: Double) -> String {
        value > 0 ? "+\(Int(value))" : "\(Int(value))"
    }
}

#Preview("MuiDragBar") {
    struct Demo: View {
        @State private var straighten = 0.0

        var body: some View {
            VStack(spacing: 16) {
                MuiDragBar(label: "Straighten", value: $straighten)
                MuiDragBar(value: .constant(35))
                MuiDragBar(label: "Locked", value: .constant(-20), disabled: true)
            }
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
