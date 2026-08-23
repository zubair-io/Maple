// MuiSlider.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.1). Labeled slider with a numeric readout, built from Text + Input.
// Wraps SwiftUI's native `Slider` (this platform's equivalent of the web
// reference's native `input[type=range]`) so keyboard operation, drag, and
// screen-reader semantics come for free rather than being reimplemented.

import SwiftUI

public struct MuiSlider: View {
    public let label: String
    @Binding public var value: Double
    public let range: ClosedRange<Double>
    public let step: Double
    public let unit: String
    public let disabled: Bool

    public init(
        label: String,
        value: Binding<Double>,
        range: ClosedRange<Double> = 0...100,
        step: Double = 1,
        unit: String = "",
        disabled: Bool = false
    ) {
        self.label = label
        self._value = value
        self.range = range
        self.step = step
        self.unit = unit
        self.disabled = disabled
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                MuiText(label, variant: .toolLabel, color: .muted)
                Spacer()
                MuiText(Self.valueLabel(value: value, step: step, unit: unit), variant: .body, color: .main)
            }

            Slider(value: $value, in: range, step: step)
                .tint(MuiTokens.primary)
                .disabled(disabled)
                .accessibilityLabel(label)
                .accessibilityValue(Self.valueLabel(value: value, step: step, unit: unit))
        }
        .opacity(disabled ? 0.45 : 1)
    }

    /// The signed, unit-suffixed readout shown beside the label. Public +
    /// static so this is unit-testable without rendering a view.
    public static func valueLabel(value: Double, step: Double, unit: String) -> String {
        MuiScrubMath.formatSignedValue(value, step: step, unit: unit)
    }
}

#Preview("MuiSlider") {
    struct Demo: View {
        @State private var exposure = 0.3
        @State private var sharpen = 40.0

        var body: some View {
            VStack(spacing: 16) {
                MuiSlider(label: "Exposure", value: $exposure, range: -2...2, step: 0.1)
                MuiSlider(label: "Sharpen", value: $sharpen, range: 0...150, step: 1)
                MuiSlider(label: "Locked", value: .constant(50), disabled: true)
            }
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
