// MuiLabelValueGrid.swift — Maple UI Molecules-L1 (unified-component-
// catalog.md §2.5; Built from: Text). A two-column metadata grid (e.g.
// EXIF: Camera / ISO / Aperture rows).

import SwiftUI

public struct MuiLabelValueRow: Identifiable, Sendable {
    public let id: String
    public let label: String
    public let value: String

    public init(id: String = UUID().uuidString, label: String, value: String) {
        self.id = id
        self.label = label
        self.value = value
    }
}

public struct MuiLabelValueGrid: View {
    public let rows: [MuiLabelValueRow]

    public init(rows: [MuiLabelValueRow]) {
        self.rows = rows
    }

    public var body: some View {
        Grid(alignment: .leading, horizontalSpacing: MuiTokens.spacingMd, verticalSpacing: MuiTokens.spacingXs) {
            ForEach(rows) { row in
                GridRow {
                    MuiText(row.label, variant: .body, color: .muted)
                    MuiText(row.value, variant: .rowLabel, truncate: true)
                }
            }
        }
    }
}

#Preview("MuiLabelValueGrid") {
    MuiLabelValueGrid(rows: [
        MuiLabelValueRow(label: "Camera", value: "DJI Mavic 3 Pro"),
        MuiLabelValueRow(label: "ISO", value: "100"),
        MuiLabelValueRow(label: "Aperture", value: "f/2.8"),
        MuiLabelValueRow(label: "Shutter", value: "1/1000s"),
    ])
    .padding()
    .background(MuiTokens.bg)
}
