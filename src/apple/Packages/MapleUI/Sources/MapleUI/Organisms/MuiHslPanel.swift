// MuiHslPanel.swift — Maple UI Organisms · Inspectors & panels
// (unified-component-catalog.md §4.3). Per-band hue / sat / luminance,
// built from Chip Row, Living Slider. Chip Row runs in `select` mode so
// exactly one band is active at a time; the panel then renders the three
// Living Sliders for whichever band is active, wired to a flat `values`
// map keyed by band id (mirroring Adjustments Panel's flat
// `sliderId`-keyed map).
//
// Chip Row's `selectedId` is nullable, but this panel's `activeBandId` is
// always a real band (defaults to "red") — so the chip row is driven
// one-way plus an explicit change handler rather than a raw two-way
// binding, which would require `activeBandId` itself to accept `nil`.

import SwiftUI

public struct MuiHslBandValue: Equatable, Sendable {
    public let hue: Double
    public let saturation: Double
    public let luminance: Double

    public init(hue: Double = 0, saturation: Double = 0, luminance: Double = 0) {
        self.hue = hue
        self.saturation = saturation
        self.luminance = luminance
    }
}

public enum MuiHslField: Sendable {
    case hue, saturation, luminance
}

public struct MuiHslPanel: View {
    public static let defaultBands: [MuiChip] = [
        MuiChip(id: "red", label: "Red"), MuiChip(id: "orange", label: "Orange"),
        MuiChip(id: "yellow", label: "Yellow"), MuiChip(id: "green", label: "Green"),
        MuiChip(id: "aqua", label: "Aqua"), MuiChip(id: "blue", label: "Blue"),
        MuiChip(id: "purple", label: "Purple"), MuiChip(id: "magenta", label: "Magenta"),
    ]

    public let bands: [MuiChip]
    public let values: [String: MuiHslBandValue]
    @Binding public var activeBandId: String
    public let valueChanged: ((String, MuiHslField, Double) -> Void)?

    public init(
        bands: [MuiChip] = MuiHslPanel.defaultBands,
        values: [String: MuiHslBandValue],
        activeBandId: Binding<String>,
        valueChanged: ((String, MuiHslField, Double) -> Void)? = nil
    ) {
        self.bands = bands
        self.values = values
        self._activeBandId = activeBandId
        self.valueChanged = valueChanged
    }

    private var activeValue: MuiHslBandValue {
        values[activeBandId] ?? MuiHslBandValue()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
            MuiChipRow(chips: bands, mode: .select, selectedId: selectBinding)
            MuiLivingSlider(label: "Hue", value: fieldBinding(.hue), range: -100...100, step: 1, bipolar: true)
            MuiLivingSlider(label: "Saturation", value: fieldBinding(.saturation), range: -100...100, step: 1, bipolar: true)
            MuiLivingSlider(label: "Luminance", value: fieldBinding(.luminance), range: -100...100, step: 1, bipolar: true)
        }
        .padding(MuiTokens.spacingMd)
    }

    private var selectBinding: Binding<String?> {
        Binding(get: { activeBandId }, set: { if let next = $0 { activeBandId = next } })
    }

    private func fieldBinding(_ field: MuiHslField) -> Binding<Double> {
        Binding(
            get: { Self.value(activeValue, for: field) },
            set: { valueChanged?(activeBandId, field, $0) }
        )
    }

    // MARK: - Pure logic (unit-testable without a live view)

    public static func value(_ band: MuiHslBandValue, for field: MuiHslField) -> Double {
        switch field {
        case .hue: return band.hue
        case .saturation: return band.saturation
        case .luminance: return band.luminance
        }
    }
}

#Preview("MuiHslPanel") {
    struct Demo: View {
        @State private var active = "red"
        @State private var values: [String: MuiHslBandValue] = ["red": MuiHslBandValue(hue: 10, saturation: -5, luminance: 0)]
        var body: some View {
            MuiHslPanel(
                values: values,
                activeBandId: $active,
                valueChanged: { band, field, value in
                    var current = values[band] ?? MuiHslBandValue()
                    switch field {
                    case .hue: current = MuiHslBandValue(hue: value, saturation: current.saturation, luminance: current.luminance)
                    case .saturation: current = MuiHslBandValue(hue: current.hue, saturation: value, luminance: current.luminance)
                    case .luminance: current = MuiHslBandValue(hue: current.hue, saturation: current.saturation, luminance: value)
                    }
                    values[band] = current
                }
            )
            .frame(width: 280, height: 220)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
