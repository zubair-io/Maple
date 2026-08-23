// MuiDivider.swift — Maple UI Divider atom.
// Contract: docs/design/maple-ui/components/divider.md

import SwiftUI

public enum MuiDividerOrientation: Sendable {
    case horizontal, vertical
}

/// Maps to `color.border` (`.standard`) vs `color.border_hi` (`.high`)
/// (divider.md §Props).
public enum MuiDividerEmphasis: Sendable {
    case standard, high
}

/// A 1px hairline separator between content regions — "hairlines do the
/// work of shadows" (divider.md §Purpose). Purely decorative: excluded
/// from the accessibility tree.
public struct MuiDivider: View {
    public let orientation: MuiDividerOrientation
    public let emphasis: MuiDividerEmphasis

    public init(orientation: MuiDividerOrientation = .horizontal, emphasis: MuiDividerEmphasis = .standard) {
        self.orientation = orientation
        self.emphasis = emphasis
    }

    public var body: some View {
        Rectangle()
            .fill(color)
            .frame(
                width: orientation == .vertical ? 1 : nil,
                height: orientation == .horizontal ? 1 : nil
            )
            .frame(
                maxWidth: orientation == .horizontal ? .infinity : nil,
                maxHeight: orientation == .vertical ? .infinity : nil
            )
            .accessibilityHidden(true)
    }

    private var color: Color {
        emphasis == .high ? MuiTokens.borderHi : MuiTokens.border
    }
}

#Preview("MuiDivider — Horizontal") {
    VStack(spacing: 12) {
        Text("Above").foregroundStyle(MuiTokens.textMain)
        MuiDivider()
        Text("Below (high emphasis)").foregroundStyle(MuiTokens.textMain)
        MuiDivider(emphasis: .high)
    }
    .padding()
    .background(MuiTokens.bg)
}

#Preview("MuiDivider — Vertical") {
    HStack(spacing: 12) {
        Text("Left").foregroundStyle(MuiTokens.textMain)
        MuiDivider(orientation: .vertical).frame(height: 24)
        Text("Right").foregroundStyle(MuiTokens.textMain)
    }
    .padding()
    .background(MuiTokens.bg)
}
