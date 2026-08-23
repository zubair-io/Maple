// MuiColorGradingPanel.swift — Maple UI Organisms · Inspectors & panels
// (unified-component-catalog.md §4.3). Shadows / mids / highlights, built
// from Color Wheel, Living Slider. Fully controlled: every value is a
// two-way `@Binding`, so the panel carries no state beyond what the
// caller hands it. A color-grading tool at rest (every wheel centered,
// blending at 50, balance at 0) is a normal starting point, not an
// "empty" condition worth a separate state.

import SwiftUI

public struct MuiColorGradingPanel: View {
    @Binding public var shadows: MuiColorWheelValue
    @Binding public var shadowsLuminance: Double
    @Binding public var midtones: MuiColorWheelValue
    @Binding public var midtonesLuminance: Double
    @Binding public var highlights: MuiColorWheelValue
    @Binding public var highlightsLuminance: Double
    @Binding public var blending: Double
    @Binding public var balance: Double

    public init(
        shadows: Binding<MuiColorWheelValue>,
        shadowsLuminance: Binding<Double>,
        midtones: Binding<MuiColorWheelValue>,
        midtonesLuminance: Binding<Double>,
        highlights: Binding<MuiColorWheelValue>,
        highlightsLuminance: Binding<Double>,
        blending: Binding<Double>,
        balance: Binding<Double>
    ) {
        self._shadows = shadows
        self._shadowsLuminance = shadowsLuminance
        self._midtones = midtones
        self._midtonesLuminance = midtonesLuminance
        self._highlights = highlights
        self._highlightsLuminance = highlightsLuminance
        self._blending = blending
        self._balance = balance
    }

    public var body: some View {
        ScrollView {
            VStack(spacing: MuiTokens.spacingLg) {
                HStack(alignment: .top, spacing: MuiTokens.spacingLg) {
                    wheel(title: "Shadows", value: $shadows, luminance: $shadowsLuminance)
                    wheel(title: "Midtones", value: $midtones, luminance: $midtonesLuminance)
                    wheel(title: "Highlights", value: $highlights, luminance: $highlightsLuminance)
                }
                MuiLivingSlider(label: "Blending", value: $blending, range: 0...100, step: 1, unit: "%")
                MuiLivingSlider(label: "Balance", value: $balance, range: -100...100, step: 1, bipolar: true)
            }
            .padding(MuiTokens.spacingMd)
        }
    }

    private func wheel(title: String, value: Binding<MuiColorWheelValue>, luminance: Binding<Double>) -> some View {
        VStack(spacing: MuiTokens.spacingXs) {
            MuiText(title, variant: .toolLabel, color: .muted)
            MuiColorWheel(value: value, size: 76, accessibilityLabel: "\(title) hue and saturation")
            MuiLivingSlider(label: "Luma", value: luminance, range: -100...100, step: 1, bipolar: true)
        }
    }
}

#Preview("MuiColorGradingPanel") {
    struct Demo: View {
        @State private var shadows = MuiColorWheelValue(hue: 210, saturation: 20)
        @State private var shadowsLuma = 0.0
        @State private var mids = MuiColorWheelValue(hue: 0, saturation: 0)
        @State private var midsLuma = 0.0
        @State private var highlights = MuiColorWheelValue(hue: 40, saturation: 15)
        @State private var highlightsLuma = 0.0
        @State private var blending = 50.0
        @State private var balance = 0.0
        var body: some View {
            MuiColorGradingPanel(
                shadows: $shadows, shadowsLuminance: $shadowsLuma,
                midtones: $mids, midtonesLuminance: $midsLuma,
                highlights: $highlights, highlightsLuminance: $highlightsLuma,
                blending: $blending, balance: $balance
            )
            .frame(width: 300, height: 340)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
