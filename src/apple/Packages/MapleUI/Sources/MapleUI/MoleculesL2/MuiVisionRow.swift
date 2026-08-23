// MuiVisionRow.swift — Maple UI Molecules-L2 (unified-component-catalog.md
// §3). Classification result chips, built from Chip Row. A thin,
// read-oriented wrapper: the underlying Chip Row still runs in `.select`
// mode (so a tag can be focused/highlighted), but this molecule doesn't
// surface a two-way selection — vision labels are model output, not a
// filter the caller needs to persist.

import SwiftUI

public struct MuiVisionRow: View {
    public let labels: [MuiChip]

    public init(labels: [MuiChip]) {
        self.labels = labels
    }

    public var body: some View {
        MuiChipRow(chips: labels, mode: .select, selectedId: .constant(nil))
            .accessibilityLabel("Vision labels")
    }
}

#Preview("MuiVisionRow") {
    MuiVisionRow(labels: [
        MuiChip(id: "1", label: "Mountain"),
        MuiChip(id: "2", label: "Snow"),
        MuiChip(id: "3", label: "Sunset"),
    ])
    .padding()
    .background(MuiTokens.bg)
}
