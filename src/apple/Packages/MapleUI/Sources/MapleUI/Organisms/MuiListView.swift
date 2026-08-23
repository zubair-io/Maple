// MuiListView.swift — Maple UI Organisms · Collections
// (unified-component-catalog.md §4.1). Virtualized row list, built from
// List Row, Empty State, Spinner. `LazyVStack` supplies the
// virtualization the web reference hand-rolls via `scrollTop` math (see
// MuiCollectionGrid's header comment for why that's unnecessary here).

import SwiftUI

public struct MuiListViewItem: Identifiable, Sendable {
    public let id: String
    public let icon: String?
    public let label: String
    public let subtitle: String?
    public let timestampValue: Date?

    public init(id: String, icon: String? = nil, label: String, subtitle: String? = nil, timestampValue: Date? = nil) {
        self.id = id
        self.icon = icon
        self.label = label
        self.subtitle = subtitle
        self.timestampValue = timestampValue
    }
}

public struct MuiListView: View {
    public let items: [MuiListViewItem]
    public let loading: Bool
    public let error: String?
    public let emptyMessage: String
    @Binding public var activeId: String?
    public let itemPressed: ((String) -> Void)?

    public init(
        items: [MuiListViewItem],
        loading: Bool = false,
        error: String? = nil,
        emptyMessage: String = "No items to show.",
        activeId: Binding<String?> = .constant(nil),
        itemPressed: ((String) -> Void)? = nil
    ) {
        self.items = items
        self.loading = loading
        self.error = error
        self.emptyMessage = emptyMessage
        self._activeId = activeId
        self.itemPressed = itemPressed
    }

    public var body: some View {
        Group {
            if loading {
                MuiSpinner(placement: .centered, label: "Loading items")
            } else if let error {
                MuiEmptyState(icon: "exclamationmark.triangle", title: "Couldn't load items", message: error)
            } else if items.isEmpty {
                MuiEmptyState(icon: "list.bullet", title: "No items", message: emptyMessage)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(items) { item in
                            MuiListRow(
                                icon: item.icon,
                                label: item.label,
                                subtitle: item.subtitle,
                                timestampValue: item.timestampValue,
                                active: item.id == activeId,
                                pressed: { select(item.id) }
                            )
                        }
                    }
                }
            }
        }
    }

    private func select(_ id: String) {
        activeId = id
        itemPressed?(id)
    }
}

#Preview("MuiListView — Populated") {
    struct Demo: View {
        @State private var active: String? = "2"
        var body: some View {
            MuiListView(
                items: [
                    MuiListViewItem(id: "1", icon: "doc", label: "Export batch.json", subtitle: "42 photos"),
                    MuiListViewItem(id: "2", icon: "photo", label: "IMG_0042.dng", timestampValue: Date().addingTimeInterval(-3600)),
                    MuiListViewItem(id: "3", icon: "folder", label: "2026 Iceland Trip", subtitle: "214 items"),
                ],
                activeId: $active
            )
            .frame(height: 220)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}

#Preview("MuiListView — Loading / Empty / Error") {
    VStack(spacing: 0) {
        MuiListView(items: [], loading: true).frame(height: 100)
        MuiDivider()
        MuiListView(items: [], emptyMessage: "Nothing here yet.").frame(height: 100)
        MuiDivider()
        MuiListView(items: [], error: "Couldn't reach the server.").frame(height: 100)
    }
    .background(MuiTokens.bg)
}
