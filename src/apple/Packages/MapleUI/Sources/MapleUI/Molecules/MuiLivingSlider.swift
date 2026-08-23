// MuiLivingSlider.swift — Maple UI Molecules-L1
// (unified-component-catalog.md §2.1). Gradient-track slider with a label +
// numeric readout, built from Text + Input. A self-contained
// design-system re-implementation of the Pro Editor's `LivingSlider`
// (src/apple/Maple/Views/LivingSlider.swift) and the web reference's
// `mui-living-slider` — same relative-drag + keyboard-nudge + double-click-
// reset contract, but dependency-free (no `MapleCore` import) and without
// the app's gradient-catalog / undo-snapshot integration.

import SwiftUI

public struct MuiLivingSlider: View {
    public let label: String
    @Binding public var value: Double
    public let range: ClosedRange<Double>
    public let step: Double
    public let gradientColors: [Color]
    /// Draws a center notch — for a range that straddles zero.
    public let bipolar: Bool
    public let unit: String
    public let disabled: Bool
    public let onCommit: (() -> Void)?

    @GestureState private var dragStartValue: Double?

    private let trackHeight: CGFloat = 8
    private var thumbDiameter: CGFloat { trackHeight + 8 }

    public init(
        label: String,
        value: Binding<Double>,
        range: ClosedRange<Double>,
        step: Double = 0.1,
        gradientColors: [Color] = [MuiTokens.border, MuiTokens.primary],
        bipolar: Bool = false,
        unit: String = "",
        disabled: Bool = false,
        onCommit: (() -> Void)? = nil
    ) {
        self.label = label
        self._value = value
        self.range = range
        self.step = step
        self.gradientColors = gradientColors
        self.bipolar = bipolar
        self.unit = unit
        self.disabled = disabled
        self.onCommit = onCommit
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                MuiText(label, variant: .toolLabel, color: .muted)
                Spacer()
                MuiText(Self.valueLabel(value: value, step: step, unit: unit), variant: .body, color: .main)
            }

            GeometryReader { geo in
                let trackWidth = geo.size.width
                let thumbPct = MuiScrubMath.percentInRange(value: value, min: range.lowerBound, max: range.upperBound, fallbackPct: 50) / 100
                let thumbRadius = thumbDiameter / 2
                let thumbX = thumbRadius + thumbPct * (trackWidth - thumbDiameter)

                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(LinearGradient(colors: gradientColors, startPoint: .leading, endPoint: .trailing))
                        .frame(height: trackHeight)
                        .overlay(Capsule().strokeBorder(MuiTokens.borderHi, lineWidth: 0.5))
                        .frame(maxWidth: .infinity)

                    if bipolar {
                        Rectangle()
                            .fill(Color.white.opacity(0.8))
                            .frame(width: 1.5, height: trackHeight)
                            .position(x: trackWidth / 2, y: trackHeight / 2)
                    }

                    Circle()
                        .fill(Color.white)
                        .frame(width: thumbDiameter, height: thumbDiameter)
                        .shadow(color: .black.opacity(0.45), radius: 1, x: 0, y: 0.5)
                        .position(x: thumbX, y: trackHeight / 2)
                }
                .frame(height: trackHeight)
                .contentShape(Rectangle().inset(by: -8))
                .gesture(dragGesture(trackWidth: trackWidth))
                .onTapGesture(count: 2) { resetToZero() }
                .accessibilityElement()
                .accessibilityLabel(label)
                .accessibilityValue(Self.valueLabel(value: value, step: step, unit: unit))
                .accessibilityAdjustableAction { direction in
                    switch direction {
                    case .increment: nudge(by: step)
                    case .decrement: nudge(by: -step)
                    @unknown default: break
                    }
                }
            }
            .frame(height: thumbDiameter)
        }
        .opacity(disabled ? 0.45 : 1)
        .allowsHitTesting(!disabled)
    }

    private func dragGesture(trackWidth: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .updating($dragStartValue) { _, state, _ in
                if state == nil { state = value }
            }
            .onChanged { g in
                value = Self.draggedValue(
                    startValue: dragStartValue ?? value,
                    deltaX: g.translation.width,
                    trackWidth: trackWidth,
                    range: range,
                    step: step
                )
            }
            .onEnded { _ in onCommit?() }
    }

    private func nudge(by delta: Double) {
        value = MuiScrubMath.snap(value + delta, step: step, min: range.lowerBound, max: range.upperBound)
        onCommit?()
    }

    private func resetToZero() {
        guard !disabled else { return }
        value = Swift.min(range.upperBound, Swift.max(range.lowerBound, 0))
        onCommit?()
    }

    /// The value that a relative drag of `deltaX` points across a track of
    /// `trackWidth`, starting from `startValue`, produces — snapped to
    /// `step` and clamped to `range`. Public + static so this is
    /// unit-testable without running a gesture.
    public static func draggedValue(
        startValue: Double,
        deltaX: CGFloat,
        trackWidth: CGFloat,
        range: ClosedRange<Double>,
        step: Double
    ) -> Double {
        guard trackWidth > 0 else { return startValue }
        let span = range.upperBound - range.lowerBound
        let raw = startValue + Double(deltaX / trackWidth) * span
        return MuiScrubMath.snap(raw, step: step, min: range.lowerBound, max: range.upperBound)
    }

    /// The signed, unit-suffixed readout shown beside the label. Public +
    /// static so this is unit-testable without rendering a view.
    public static func valueLabel(value: Double, step: Double, unit: String) -> String {
        MuiScrubMath.formatSignedValue(value, step: step, unit: unit)
    }
}

#Preview("MuiLivingSlider") {
    struct Demo: View {
        @State private var exposure = 0.0
        @State private var temp = 6500.0

        var body: some View {
            VStack(spacing: 16) {
                MuiLivingSlider(
                    label: "Exposure",
                    value: $exposure,
                    range: -4...4,
                    step: 0.05,
                    gradientColors: [.blue, .white, .orange],
                    bipolar: true
                )
                MuiLivingSlider(
                    label: "Temp",
                    value: $temp,
                    range: 2000...12000,
                    step: 50,
                    gradientColors: [.blue, .white, .orange],
                    unit: "K"
                )
            }
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
