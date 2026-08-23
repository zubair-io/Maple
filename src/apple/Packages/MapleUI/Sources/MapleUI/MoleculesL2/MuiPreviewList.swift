// MuiPreviewList.swift — Maple UI Molecules-L2 (unified-component-
// catalog.md §3). Before -> after row list, built from List Row, Text.

import SwiftUI

public struct MuiPreviewItem: Identifiable, Sendable {
    public let id: String
    public let before: String
    public let after: String

    public init(id: String, before: String, after: String) {
        self.id = id
        self.before = before
        self.after = after
    }
}

public struct MuiPreviewList: View {
    public let items: [MuiPreviewItem]
    public let pressed: ((String) -> Void)?

    public init(items: [MuiPreviewItem], pressed: ((String) -> Void)? = nil) {
        self.items = items
        self.pressed = pressed
    }

    public var body: some View {
        VStack(spacing: 0) {
            ForEach(items) { item in
                MuiListRow(label: item.before, pressed: { pressed?(item.id) }) {
                    MuiText(item.after, variant: .chipLabel, color: .muted, truncate: true)
                }
            }
        }
    }
}

#Preview("MuiPreviewList") {
    MuiPreviewList(items: [
        MuiPreviewItem(id: "1", before: "IMG_0042.dng", after: "iceland-glacier-01.dng"),
        MuiPreviewItem(id: "2", before: "IMG_0043.dng", after: "iceland-glacier-02.dng"),
    ])
    .background(MuiTokens.bg)
}
