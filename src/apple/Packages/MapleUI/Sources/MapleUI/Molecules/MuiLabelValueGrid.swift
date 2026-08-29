// MuiLabelValueGrid.swift — Maple UI Molecules-L1 (unified-component-
// catalog.md §2.5; Built from: Text, Link). A two-column metadata grid
// (e.g. EXIF: Camera / ISO / Aperture rows). A row can opt into rendering
// its value as a `MuiLink` instead of plain text — e.g. a "reveal in
// Finder" path row — via `isLink`; the grid stays plain `Text` for every
// other row so a metadata table with exactly one actionable field doesn't
// need a second component.

import SwiftUI

public struct MuiLabelValueRow: Identifiable, Sendable {
    public let id: String
    public let label: String
    public let value: String
    /// When `true` and the grid was given a non-nil `linkTapped` handler,
    /// this row's value renders as a tappable `MuiLink` (row `id` is
    /// passed back to `linkTapped`) instead of plain text.
    public let isLink: Bool

    public init(id: String = UUID().uuidString, label: String, value: String, isLink: Bool = false) {
        self.id = id
        self.label = label
        self.value = value
        self.isLink = isLink
    }
}

public struct MuiLabelValueGrid: View {
    public let rows: [MuiLabelValueRow]
    public let linkTapped: ((String) -> Void)?

    public init(rows: [MuiLabelValueRow], linkTapped: ((String) -> Void)? = nil) {
        self.rows = rows
        self.linkTapped = linkTapped
    }

    public var body: some View {
        Grid(alignment: .leading, horizontalSpacing: MuiTokens.spacingMd, verticalSpacing: MuiTokens.spacingXs) {
            ForEach(rows) { row in
                GridRow {
                    MuiText(row.label, variant: .body, color: .muted)
                    if row.isLink, let linkTapped {
                        MuiLink(title: row.value, href: "", action: { linkTapped(row.id) })
                            .lineLimit(2)
                    } else {
                        MuiText(row.value, variant: .rowLabel, truncate: true)
                    }
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

#Preview("MuiLabelValueGrid — with a link row") {
    MuiLabelValueGrid(
        rows: [
            MuiLabelValueRow(label: "Camera", value: "DJI Mavic 3 Pro"),
            MuiLabelValueRow(label: "Path", value: "Photos/2026/Iceland", isLink: true),
        ],
        linkTapped: { _ in }
    )
    .padding()
    .background(MuiTokens.bg)
}
