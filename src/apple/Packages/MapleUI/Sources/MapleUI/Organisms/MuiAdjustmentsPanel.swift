// MuiAdjustmentsPanel.swift — Maple UI Organisms · Inspectors & panels
// (unified-component-catalog.md §4.3). All tool-group sliders, built from
// Living Slider, Collapsible, Tabs. Slider values live in one flat
// `values` map keyed by slider id (not nested per tab/group) — the
// caller's contract is that slider ids stay globally unique across every
// tab, so a single map can address them all. Collapsible-group
// open/closed state is owned locally and seeded once from each group's
// `collapsedByDefault`, then left to the user's own toggling from there.
//
// Authentic Maple slider names (per the wave brief): Light group —
// Exposure / Contrast / Highlights / Shadows / Whites / Blacks; Color
// group — Temp / Tint / Vibrance / Saturation.

import SwiftUI

public struct MuiAdjustmentSlider: Identifiable, Sendable {
    public let id: String
    public let label: String
    public let min: Double
    public let max: Double
    public let step: Double
    public let unit: String
    public let bipolar: Bool
    public let gradientColors: [Color]?

    public init(
        id: String,
        label: String,
        min: Double,
        max: Double,
        step: Double = 1,
        unit: String = "",
        bipolar: Bool = false,
        gradientColors: [Color]? = nil
    ) {
        self.id = id
        self.label = label
        self.min = min
        self.max = max
        self.step = step
        self.unit = unit
        self.bipolar = bipolar
        self.gradientColors = gradientColors
    }
}

public struct MuiAdjustmentGroup: Identifiable, Sendable {
    public let id: String
    public let label: String
    public let sliders: [MuiAdjustmentSlider]
    public let collapsedByDefault: Bool

    public init(id: String, label: String, sliders: [MuiAdjustmentSlider], collapsedByDefault: Bool = false) {
        self.id = id
        self.label = label
        self.sliders = sliders
        self.collapsedByDefault = collapsedByDefault
    }
}

public struct MuiAdjustmentTab: Identifiable, Sendable {
    public let id: String
    public let label: String
    public let groups: [MuiAdjustmentGroup]

    public init(id: String, label: String, groups: [MuiAdjustmentGroup]) {
        self.id = id
        self.label = label
        self.groups = groups
    }
}

public struct MuiAdjustmentsPanel: View {
    public let tabs: [MuiAdjustmentTab]
    public let values: [String: Double]
    @Binding public var activeTabId: String
    public let valueChanged: ((String, Double) -> Void)?

    @State private var openGroupIds: [String] = []

    public init(
        tabs: [MuiAdjustmentTab],
        values: [String: Double],
        activeTabId: Binding<String>,
        valueChanged: ((String, Double) -> Void)? = nil
    ) {
        self.tabs = tabs
        self.values = values
        self._activeTabId = activeTabId
        self.valueChanged = valueChanged
    }

    private var activeGroups: [MuiAdjustmentGroup] {
        tabs.first(where: { $0.id == activeTabId })?.groups ?? []
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !tabs.isEmpty {
                MuiTabs(tabs: tabs.map { MuiTab(id: $0.id, label: $0.label) }, activeId: $activeTabId)
                    .padding(.horizontal, MuiTokens.spacingMd)
                    .padding(.vertical, MuiTokens.spacingSm)
                MuiDivider()
            }
            ScrollView {
                VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                    ForEach(activeGroups) { group in
                        MuiCollapsible(label: group.label, open: openBinding(for: group.id)) {
                            VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                                ForEach(group.sliders) { slider in
                                    MuiLivingSlider(
                                        label: slider.label,
                                        value: valueBinding(for: slider.id),
                                        range: slider.min...slider.max,
                                        step: slider.step,
                                        gradientColors: slider.gradientColors ?? [MuiTokens.border, MuiTokens.primary],
                                        bipolar: slider.bipolar,
                                        unit: slider.unit
                                    )
                                }
                            }
                        }
                    }
                }
                .padding(MuiTokens.spacingMd)
            }
        }
        .onAppear {
            if openGroupIds.isEmpty {
                openGroupIds = Self.initialOpenGroupIds(tabs: tabs)
            }
        }
    }

    private func openBinding(for id: String) -> Binding<Bool> {
        Binding(
            get: { openGroupIds.contains(id) },
            set: { isOpen in
                openGroupIds = isOpen ? openGroupIds + [id] : openGroupIds.filter { $0 != id }
            }
        )
    }

    private func valueBinding(for sliderId: String) -> Binding<Double> {
        Binding(
            get: { values[sliderId] ?? 0 },
            set: { valueChanged?(sliderId, $0) }
        )
    }

    // MARK: - Pure logic (unit-testable without a live view)

    /// Every group id across every tab that isn't `collapsedByDefault` —
    /// the seed for `openGroupIds` on first render, mirroring the web
    /// reference's `tabs().flatMap(t => t.groups).filter(...)`.
    public static func initialOpenGroupIds(tabs: [MuiAdjustmentTab]) -> [String] {
        tabs.flatMap(\.groups).filter { !$0.collapsedByDefault }.map(\.id)
    }

    /// Maple's real Light and Color tool-group slider names (wave brief),
    /// for gallery specimens and default fixtures.
    public static let lightGroup = MuiAdjustmentGroup(id: "light", label: "Light", sliders: [
        MuiAdjustmentSlider(id: "exposure", label: "Exposure", min: -5, max: 5, step: 0.01, bipolar: true),
        MuiAdjustmentSlider(id: "contrast", label: "Contrast", min: -100, max: 100, bipolar: true),
        MuiAdjustmentSlider(id: "highlights", label: "Highlights", min: -100, max: 100, bipolar: true),
        MuiAdjustmentSlider(id: "shadows", label: "Shadows", min: -100, max: 100, bipolar: true),
        MuiAdjustmentSlider(id: "whites", label: "Whites", min: -100, max: 100, bipolar: true),
        MuiAdjustmentSlider(id: "blacks", label: "Blacks", min: -100, max: 100, bipolar: true),
    ])

    public static let colorGroup = MuiAdjustmentGroup(id: "color", label: "Color", sliders: [
        MuiAdjustmentSlider(id: "temp", label: "Temp", min: 2000, max: 50000, step: 50, unit: "K"),
        MuiAdjustmentSlider(id: "tint", label: "Tint", min: -150, max: 150, bipolar: true),
        MuiAdjustmentSlider(id: "vibrance", label: "Vibrance", min: -100, max: 100, bipolar: true),
        MuiAdjustmentSlider(id: "saturation", label: "Saturation", min: -100, max: 100, bipolar: true),
    ])
}

#Preview("MuiAdjustmentsPanel") {
    struct Demo: View {
        @State private var activeTab = "basic"
        @State private var values: [String: Double] = ["exposure": 0.3, "contrast": 12, "temp": 5500]
        var body: some View {
            MuiAdjustmentsPanel(
                tabs: [MuiAdjustmentTab(id: "basic", label: "Basic", groups: [MuiAdjustmentsPanel.lightGroup, MuiAdjustmentsPanel.colorGroup])],
                values: values,
                activeTabId: $activeTab,
                valueChanged: { id, value in values[id] = value }
            )
            .frame(width: 280, height: 520)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
