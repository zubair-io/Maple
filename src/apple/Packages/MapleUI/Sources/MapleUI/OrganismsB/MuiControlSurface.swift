// MuiControlSurface.swift — Maple UI Organisms · Editing surfaces
// (unified-component-catalog.md §4.5). Panel for the armed tool: a tab
// strip switching between tool groups plus the living-slider stack for
// whichever tool is active, built from Tabs, Living Slider, Chip Row,
// Value Chip.
//
// `sliders` is a plain one-way input, not a full catalog — it already
// represents "the sliders visible for the currently active tab" (same
// one-way-down/events-up flow as the web reference). A `MuiValueChip`
// summarizes how many adjustments are visible for the active tool; there's
// no genuine role for a chip *row* here since only one tab strip is ever
// shown and each slider already renders its own inline value readout.

import SwiftUI

public struct MuiControlSurfaceSlider: Identifiable, Sendable {
    public let id: String
    public let label: String
    public let value: Double
    public let min: Double
    public let max: Double
    public let step: Double
    public let unit: String

    public init(id: String, label: String, value: Double, min: Double, max: Double, step: Double = 1, unit: String = "") {
        self.id = id
        self.label = label
        self.value = value
        self.min = min
        self.max = max
        self.step = step
        self.unit = unit
    }
}

public struct MuiControlSurface: View {
    public let tabs: [MuiTab]
    @Binding public var activeTabId: String
    public let sliders: [MuiControlSurfaceSlider]
    public let sliderChanged: ((String, Double) -> Void)?

    public init(
        tabs: [MuiTab],
        activeTabId: Binding<String>,
        sliders: [MuiControlSurfaceSlider],
        sliderChanged: ((String, Double) -> Void)? = nil
    ) {
        self.tabs = tabs
        self._activeTabId = activeTabId
        self.sliders = sliders
        self.sliderChanged = sliderChanged
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
            HStack {
                MuiTabs(tabs: tabs, activeId: $activeTabId)
                Spacer()
                MuiValueChip(label: "Adjustments", value: "\(sliders.count)")
            }

            if sliders.isEmpty {
                MuiEmptyState(icon: "slider.horizontal.3", title: "No adjustments", message: "This tool has nothing to tune yet.")
            } else {
                ScrollView {
                    VStack(spacing: MuiTokens.spacingMd) {
                        ForEach(sliders) { slider in
                            MuiLivingSlider(
                                label: slider.label,
                                value: Binding(get: { slider.value }, set: { sliderChanged?(slider.id, $0) }),
                                range: slider.min...slider.max,
                                step: slider.step,
                                bipolar: Self.bipolar(slider),
                                unit: slider.unit
                            )
                        }
                    }
                }
            }
        }
    }

    /// A slider straddles zero (bipolar) whenever its range spans both
    /// sides of it — drives `MuiLivingSlider`'s center-notch. Public +
    /// static so this is unit-testable without rendering a view.
    public static func bipolar(_ slider: MuiControlSurfaceSlider) -> Bool {
        slider.min < 0 && slider.max > 0
    }
}

#Preview("MuiControlSurface") {
    struct Demo: View {
        @State private var activeTab = "light"
        @State private var sliders: [MuiControlSurfaceSlider] = [
            MuiControlSurfaceSlider(id: "exposure", label: "Exposure", value: 0.3, min: -5, max: 5, step: 0.1, unit: "EV"),
            MuiControlSurfaceSlider(id: "contrast", label: "Contrast", value: 12, min: -100, max: 100),
        ]
        var body: some View {
            MuiControlSurface(
                tabs: [MuiTab(id: "light", label: "Light"), MuiTab(id: "color", label: "Color")],
                activeTabId: $activeTab,
                sliders: sliders,
                sliderChanged: { id, value in
                    if let idx = sliders.firstIndex(where: { $0.id == id }) {
                        sliders[idx] = MuiControlSurfaceSlider(id: id, label: sliders[idx].label, value: value, min: sliders[idx].min, max: sliders[idx].max, step: sliders[idx].step, unit: sliders[idx].unit)
                    }
                }
            )
            .frame(width: 280, height: 260)
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
