// ColorGradingPanel.swift — Color Grading tool surface (#275).
//
// Replaces the flat sub-param-chip + slider stack while the Color Grading
// tool is armed — the same swap-in-a-custom-surface pattern `CropOverlay`
// uses for the Crop tool (see `FlyoutSliderPanel` / `MobileControlBar` /
// `StackedAdjustmentsPanel`, each of which special-cases `armedTool == .crop`
// for `CropToolbar` the same way they special-case `armedTool == .colorGrade`
// for this panel).
//
// Layout: four `ColorWheelView`s (Shadows / Midtones / Highlights / Global)
// in a 2×2 grid, each paired with its zone's luminance offset slider, plus
// the balance slider underneath — thirteen controls total, matching
// `Tool.colorGrade.subParams`. The scalar sliders reuse the plain
// `LivingSlider` primitive (not `LivingSliderRow`, which is tool-keyed
// rather than field-keyed) so their visuals match every other slider in
// the editor.
//
// Shadows/Highlights hue+saturation read/write the `splitTone*` fields
// (ACR's own `crs:SplitToning*` layout); Midtones/Global and every
// luminance offset read/write the new `colorGrade*` fields. See
// `AdjustmentModel`'s Color Grading doc comment for the full field list.

import SwiftUI
import MapleCore

struct ColorGradingPanel: View {
    @Bindable var state: EditorState

    private struct Zone {
        let title: String
        let hue: WritableKeyPath<AdjustmentModel, Double>
        let saturation: WritableKeyPath<AdjustmentModel, Double>
        let luminance: WritableKeyPath<AdjustmentModel, Double>
        let luminanceRange: ClosedRange<Double>
    }

    private var zones: [Zone] {
        [
            Zone(title: "Shadows",
                 hue: \.splitToneShadowHue, saturation: \.splitToneShadowSaturation,
                 luminance: \.colorGradeShadowLuminance,
                 luminanceRange: AdjustmentModel.colorGradeShadowLuminanceRange),
            Zone(title: "Midtones",
                 hue: \.colorGradeMidtoneHue, saturation: \.colorGradeMidtoneSaturation,
                 luminance: \.colorGradeMidtoneLuminance,
                 luminanceRange: AdjustmentModel.colorGradeMidtoneLuminanceRange),
            Zone(title: "Highlights",
                 hue: \.splitToneHighlightHue, saturation: \.splitToneHighlightSaturation,
                 luminance: \.colorGradeHighlightLuminance,
                 luminanceRange: AdjustmentModel.colorGradeHighlightLuminanceRange),
            Zone(title: "Global",
                 hue: \.colorGradeGlobalHue, saturation: \.colorGradeGlobalSaturation,
                 luminance: \.colorGradeGlobalLuminance,
                 luminanceRange: AdjustmentModel.colorGradeGlobalLuminanceRange),
        ]
    }

    private let columns = [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            LazyVGrid(columns: columns, spacing: 16) {
                ForEach(zones, id: \.title) { zone in
                    zoneCell(zone)
                }
            }
            LivingSlider(
                label: "Balance",
                value: bind(\.splitToneBalance),
                range: AdjustmentModel.splitToneBalanceRange,
                isBipolar: true,
                defaultValue: 0,
                onCommit: { state.commit() }
            )
        }
        .padding(.vertical, 4)
        .accessibilityIdentifier("editor-color-grading-panel")
    }

    private func zoneCell(_ zone: Zone) -> some View {
        VStack(spacing: 8) {
            Text(zone.title.uppercased())
                .font(.system(size: 9, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(ProTokens.textMuted)

            ColorWheelView(
                label: "\(zone.title) colour wheel",
                hue: bind(zone.hue),
                saturation: bind(zone.saturation),
                onCommit: { state.commit() }
            )
            .frame(width: 96, height: 96)

            LivingSlider(
                label: "Lum",
                value: bind(zone.luminance),
                range: zone.luminanceRange,
                isBipolar: true,
                defaultValue: 0,
                onCommit: { state.commit() }
            )
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("editor-color-grading-zone-\(zone.title.lowercased())")
    }

    private func bind(_ keyPath: WritableKeyPath<AdjustmentModel, Double>) -> Binding<Double> {
        Binding(
            get: { state.session.model[keyPath: keyPath] },
            set: { state.session.model[keyPath: keyPath] = $0 }
        )
    }
}
