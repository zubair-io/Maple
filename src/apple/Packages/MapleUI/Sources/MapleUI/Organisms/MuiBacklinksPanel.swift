// MuiBacklinksPanel.swift — Maple UI Organisms · Inspectors & panels
// (unified-component-catalog.md §4.3). Inbound-reference list for the
// active asset/page, built from List Row, Empty State.

import SwiftUI

public struct MuiBacklinkItem: Identifiable, Sendable {
    public let id: String
    public let icon: String?
    public let label: String
    public let subtitle: String?

    public init(id: String, icon: String? = nil, label: String, subtitle: String? = nil) {
        self.id = id
        self.icon = icon
        self.label = label
        self.subtitle = subtitle
    }
}

public struct MuiBacklinksPanel: View {
    public let links: [MuiBacklinkItem]
    public let loading: Bool
    public let emptyMessage: String
    public let pressed: ((String) -> Void)?

    public init(
        links: [MuiBacklinkItem],
        loading: Bool = false,
        emptyMessage: String = "No backlinks yet.",
        pressed: ((String) -> Void)? = nil
    ) {
        self.links = links
        self.loading = loading
        self.emptyMessage = emptyMessage
        self.pressed = pressed
    }

    public var body: some View {
        Group {
            if loading {
                MuiSpinner(placement: .centered, label: "Loading backlinks")
            } else if links.isEmpty {
                MuiEmptyState(icon: "link", title: "No backlinks", message: emptyMessage)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(links) { link in
                            MuiListRow(icon: link.icon, label: link.label, subtitle: link.subtitle, pressed: { pressed?(link.id) })
                        }
                    }
                }
            }
        }
    }
}

#Preview("MuiBacklinksPanel") {
    MuiBacklinksPanel(links: [
        MuiBacklinkItem(id: "1", icon: "note.text", label: "Iceland trip journal", subtitle: "Referenced in 3 places"),
        MuiBacklinkItem(id: "2", icon: "rectangle.stack", label: "2026 Portfolio Board"),
    ])
    .frame(width: 260, height: 160)
    .background(MuiTokens.bg)
}

#Preview("MuiBacklinksPanel — Loading / Empty") {
    VStack(spacing: 0) {
        MuiBacklinksPanel(links: [], loading: true).frame(height: 100)
        MuiDivider()
        MuiBacklinksPanel(links: []).frame(height: 140)
    }
    .background(MuiTokens.bg)
}
