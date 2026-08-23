// MuiNotificationFeed.swift — Maple UI Organisms · Communication
// (unified-component-catalog.md §4.7). Filterable activity list, built
// from Chip Row, List Row, Empty State.

import SwiftUI

public struct MuiNotificationItem: Identifiable, Sendable {
    public let id: String
    public let label: String
    public let category: String
    public let timestamp: Date
    public let read: Bool

    public init(id: String, label: String, category: String, timestamp: Date, read: Bool = false) {
        self.id = id
        self.label = label
        self.category = category
        self.timestamp = timestamp
        self.read = read
    }
}

public struct MuiNotificationFeed: View {
    public static let allFilterId = "all"

    public let notifications: [MuiNotificationItem]
    public let filters: [MuiChip]
    @Binding public var activeFilterId: String
    public let notificationOpened: ((String) -> Void)?
    public let markedRead: ((String) -> Void)?

    public init(
        notifications: [MuiNotificationItem],
        filters: [MuiChip] = MuiNotificationFeed.defaultFilters,
        activeFilterId: Binding<String>,
        notificationOpened: ((String) -> Void)? = nil,
        markedRead: ((String) -> Void)? = nil
    ) {
        self.notifications = notifications
        self.filters = filters
        self._activeFilterId = activeFilterId
        self.notificationOpened = notificationOpened
        self.markedRead = markedRead
    }

    public static let defaultFilters: [MuiChip] = [
        MuiChip(id: allFilterId, label: "All"),
        MuiChip(id: "mentions", label: "Mentions"),
        MuiChip(id: "shares", label: "Shares"),
    ]

    private var filtered: [MuiNotificationItem] {
        Self.filtered(notifications, byFilterId: activeFilterId)
    }

    /// The notifications matching `filterId` — every notification when
    /// `filterId` is `allFilterId`, otherwise only those whose category
    /// matches exactly. Public + static so this is unit-testable without
    /// rendering a view.
    public static func filtered(_ notifications: [MuiNotificationItem], byFilterId filterId: String) -> [MuiNotificationItem] {
        filterId == allFilterId ? notifications : notifications.filter { $0.category == filterId }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
            MuiChipRow(chips: filters, mode: .select, selectedId: Binding(get: { activeFilterId }, set: { activeFilterId = $0 ?? Self.allFilterId }))
                .padding(.horizontal, MuiTokens.spacingMd)

            if filtered.isEmpty {
                MuiEmptyState(icon: "bell", title: "No notifications", message: "You're all caught up.")
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(filtered) { notification in
                            MuiListRow(
                                icon: notification.read ? "bell" : "bell.badge",
                                label: notification.label,
                                timestampValue: notification.timestamp,
                                pressed: { notificationOpened?(notification.id) }
                            ) {
                                if !notification.read {
                                    Button {
                                        markedRead?(notification.id)
                                    } label: {
                                        MuiText("Mark read", variant: .toolLabel, color: .muted)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

#Preview("MuiNotificationFeed") {
    struct Demo: View {
        @State private var filter = MuiNotificationFeed.allFilterId
        var body: some View {
            MuiNotificationFeed(
                notifications: [
                    MuiNotificationItem(id: "1", label: "Ada mentioned you", category: "mentions", timestamp: Date().addingTimeInterval(-600)),
                    MuiNotificationItem(id: "2", label: "Grace shared Iceland 2026", category: "shares", timestamp: Date().addingTimeInterval(-3600), read: true),
                ],
                activeFilterId: $filter
            )
            .frame(width: 280, height: 260)
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
