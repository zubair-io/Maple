// MuiValueChip.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.3). Floating value readout shown during a drag (e.g. above a slider
// thumb), built from Badge + Text. Purely presentational — positioning it
// against the dragged control is the caller's concern.

import SwiftUI

public struct MuiValueChip: View {
    public let label: String
    public let value: String

    public init(label: String, value: String) {
        self.label = label
        self.value = value
    }

    public var body: some View {
        HStack(spacing: 4) {
            MuiText(label, variant: .chipLabel, color: .muted)
            MuiBadge(variant: .count, value: value)
        }
        .padding(.horizontal, MuiTokens.spacingSm)
        .padding(.vertical, 4)
        .background(MuiTokens.surface, in: Capsule())
        .overlay(Capsule().stroke(MuiTokens.borderHi, lineWidth: 1))
        .shadow(color: .black.opacity(0.35), radius: 6, x: 0, y: 2)
        .accessibilityElement(children: .combine)
    }
}

#Preview("MuiValueChip") {
    HStack(spacing: 12) {
        MuiValueChip(label: "Exposure", value: "+0.35")
        MuiValueChip(label: "Temp", value: "5800K")
    }
    .padding()
    .background(MuiTokens.imageCanvas)
}
