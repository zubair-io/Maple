// MuiPageNotifications.swift — Maple UI Pages (unified-component-
// catalog.md §6). App Shell hosting a single Notification Feed organism.
//
// Notification Feed already owns its own filter-chip wiring (tested at
// the organism tier) — `markedRead` and `notificationOpened` are plain
// one-way events the caller (this page) is expected to act on. The
// genuinely new wiring here: opening a notification marks it read too
// (not just the explicit "Mark read" button), the same "opening implies
// read" behavior every real notification center has.
// `MuiPageNotifications.markingRead` is the pure reducer behind both
// paths.

import SwiftUI

public struct MuiPageNotifications: View {
    @State private var notifications: [MuiNotificationItem]
    @State private var activeFilterId = MuiNotificationFeed.allFilterId

    public init(notifications: [MuiNotificationItem] = MuiPageNotifications.defaultNotifications) {
        self._notifications = State(initialValue: notifications)
    }

    public var body: some View {
        MuiAppShell {
            EmptyView()
        } content: {
            MuiNotificationFeed(
                notifications: notifications,
                activeFilterId: $activeFilterId,
                notificationOpened: { markRead($0) },
                markedRead: { markRead($0) }
            )
            .padding(MuiTokens.spacingMd)
        }
        .background(MuiTokens.bg)
    }

    private func markRead(_ id: String) {
        notifications = Self.markingRead(notifications, id: id)
    }

    // MARK: - Pure wiring logic (unit-testable without a live view)

    /// `notifications` with the entry matching `id` set to `read: true` —
    /// a no-op array (same values, new instance) when `id` doesn't match
    /// anything, so a stale event never crashes the page.
    public static func markingRead(_ notifications: [MuiNotificationItem], id: String) -> [MuiNotificationItem] {
        notifications.map { notification in
            guard notification.id == id else { return notification }
            return MuiNotificationItem(id: notification.id, label: notification.label, category: notification.category, timestamp: notification.timestamp, read: true)
        }
    }

    // MARK: - Default mock data

    public static let defaultNotifications: [MuiNotificationItem] = [
        MuiNotificationItem(id: "1", label: "Ada mentioned you in Iceland — March 2026", category: "mentions", timestamp: Date().addingTimeInterval(-600)),
        MuiNotificationItem(id: "2", label: "Grace shared \"2026 Portfolio Board\" with you", category: "shares", timestamp: Date().addingTimeInterval(-3_600)),
        MuiNotificationItem(id: "3", label: "Backup to NAS completed", category: "system", timestamp: Date().addingTimeInterval(-7_200), read: true),
    ]
}

#Preview("MuiPageNotifications") {
    MuiPageNotifications()
        .frame(width: 420, height: 400)
}
