// MuiValueHUD.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.3). Center-screen scrub overlay, built from Text + Progress. Purely
// presentational — showing/hiding and positioning it over the canvas
// during a gesture is the caller's concern.

import SwiftUI

public struct MuiValueHUD: View {
    public let label: String
    public let value: String
    /// `0-100`, or `nil` to hide the progress track (e.g. an unbounded
    /// tool).
    public let progressPct: Double?

    public init(label: String, value: String, progressPct: Double? = nil) {
        self.label = label
        self.value = value
        self.progressPct = progressPct
    }

    public var body: some View {
        VStack(spacing: MuiTokens.spacingXs) {
            MuiText(label, variant: .eyebrow, color: .muted, block: true)
                .multilineTextAlignment(.center)
            MuiText(value, variant: .sheetTitle, block: true)
                .multilineTextAlignment(.center)
            if let progressPct {
                MuiProgress(shape: .bar, size: .sm, value: progressPct)
                    .frame(width: 120)
            }
        }
        .padding(MuiTokens.spacingLg)
        .background(MuiTokens.surface.opacity(0.92), in: RoundedRectangle(cornerRadius: MuiTokens.radiusLg, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: MuiTokens.radiusLg, style: .continuous)
                .stroke(MuiTokens.borderHi, lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }
}

#Preview("MuiValueHUD") {
    HStack(spacing: 24) {
        MuiValueHUD(label: "Exposure", value: "+0.35 EV")
        MuiValueHUD(label: "Export", value: "42%", progressPct: 42)
    }
    .padding()
    .background(MuiTokens.imageCanvas)
}
