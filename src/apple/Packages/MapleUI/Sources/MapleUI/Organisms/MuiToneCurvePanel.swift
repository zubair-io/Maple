// MuiToneCurvePanel.swift — Maple UI Organisms · Inspectors & panels
// (unified-component-catalog.md §4.3). Channel curve plus parametrics,
// built from Tabs, Curve Plot, Living Slider. The per-channel curve
// points route through an explicit `pointsChanged` callback (rather than
// a plain two-way binding) because they're keyed by channel id — the
// caller owns the `[channelId: points]` map and decides where an edit to
// the active channel's curve lands. The four parametric-region sliders
// (Highlights / Lights / Darks / Shadows) are fully controlled bindings
// since they aren't keyed by anything.

import SwiftUI

public struct MuiToneCurvePanel: View {
    public static let defaultChannels: [MuiTab] = [
        MuiTab(id: "rgb", label: "RGB"), MuiTab(id: "red", label: "Red"),
        MuiTab(id: "green", label: "Green"), MuiTab(id: "blue", label: "Blue"),
    ]

    public let channels: [MuiTab]
    public let points: [String: [MuiCurvePoint]]
    @Binding public var highlights: Double
    @Binding public var lights: Double
    @Binding public var darks: Double
    @Binding public var shadows: Double
    @Binding public var activeChannelId: String
    public let pointsChanged: ((String, [MuiCurvePoint]) -> Void)?

    public init(
        channels: [MuiTab] = MuiToneCurvePanel.defaultChannels,
        points: [String: [MuiCurvePoint]],
        highlights: Binding<Double>,
        lights: Binding<Double>,
        darks: Binding<Double>,
        shadows: Binding<Double>,
        activeChannelId: Binding<String>,
        pointsChanged: ((String, [MuiCurvePoint]) -> Void)? = nil
    ) {
        self.channels = channels
        self.points = points
        self._highlights = highlights
        self._lights = lights
        self._darks = darks
        self._shadows = shadows
        self._activeChannelId = activeChannelId
        self.pointsChanged = pointsChanged
    }

    private var activePointsBinding: Binding<[MuiCurvePoint]> {
        Binding(
            get: { points[activeChannelId] ?? MuiCurvePoint.defaultPoints },
            set: { pointsChanged?(activeChannelId, $0) }
        )
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
            MuiTabs(tabs: channels, activeId: $activeChannelId)
            MuiCurvePlot(points: activePointsBinding, width: 220, height: 160)
                .frame(maxWidth: .infinity, alignment: .center)
            MuiLivingSlider(label: "Highlights", value: $highlights, range: -100...100, step: 1, bipolar: true)
            MuiLivingSlider(label: "Lights", value: $lights, range: -100...100, step: 1, bipolar: true)
            MuiLivingSlider(label: "Darks", value: $darks, range: -100...100, step: 1, bipolar: true)
            MuiLivingSlider(label: "Shadows", value: $shadows, range: -100...100, step: 1, bipolar: true)
        }
        .padding(MuiTokens.spacingMd)
    }
}

#Preview("MuiToneCurvePanel") {
    struct Demo: View {
        @State private var points: [String: [MuiCurvePoint]] = ["rgb": [MuiCurvePoint(x: 0, y: 0), MuiCurvePoint(x: 0.5, y: 0.58), MuiCurvePoint(x: 1, y: 1)]]
        @State private var highlights = 0.0
        @State private var lights = 0.0
        @State private var darks = 0.0
        @State private var shadows = 0.0
        @State private var activeChannel = "rgb"
        var body: some View {
            MuiToneCurvePanel(
                points: points,
                highlights: $highlights, lights: $lights, darks: $darks, shadows: $shadows,
                activeChannelId: $activeChannel,
                pointsChanged: { channel, next in points[channel] = next }
            )
            .frame(width: 280, height: 460)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
