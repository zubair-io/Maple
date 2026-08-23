// MuiFacesRow.swift — Maple UI Molecules-L2 (unified-component-catalog.md
// §3). Count, person chips, re-detect — built from Chip Row, Button, Text.

import SwiftUI

public struct MuiFacesRow: View {
    public let people: [MuiChip]
    @Binding public var selectedId: String?
    public let redetecting: Bool
    public let redetect: (() -> Void)?

    public init(
        people: [MuiChip],
        selectedId: Binding<String?> = .constant(nil),
        redetecting: Bool = false,
        redetect: (() -> Void)? = nil
    ) {
        self.people = people
        self._selectedId = selectedId
        self.redetecting = redetecting
        self.redetect = redetect
    }

    public var body: some View {
        HStack(spacing: MuiTokens.spacingSm) {
            MuiText(Self.countLabel(count: people.count), variant: .toolLabel, color: .muted)

            if !people.isEmpty {
                MuiChipRow(chips: people, mode: .select, selectedId: $selectedId)
            }

            MuiButton(label: "Re-detect", variant: .ghost, size: .sm, leadingIcon: "clock.arrow.circlepath", isLoading: redetecting) {
                redetect?()
            }
        }
    }

    /// The count caption — "1 person" vs "N people". Public + static so
    /// this is unit-testable without rendering a view.
    public static func countLabel(count: Int) -> String {
        count == 1 ? "1 person" : "\(count) people"
    }
}

#Preview("MuiFacesRow") {
    VStack(alignment: .leading, spacing: 16) {
        MuiFacesRow(
            people: [MuiChip(id: "1", label: "Ada"), MuiChip(id: "2", label: "Grace")],
            selectedId: .constant("1")
        )
        MuiFacesRow(people: [], redetecting: true)
    }
    .padding()
    .background(MuiTokens.bg)
}
