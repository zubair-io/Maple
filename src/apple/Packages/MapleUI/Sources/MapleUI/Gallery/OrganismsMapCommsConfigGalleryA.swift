// OrganismsMapCommsConfigGalleryA.swift — Organisms §4.6 (Map), §4.7
// (Communication), and the first half of §4.8 (Configuration): Map
// Surface, Chat, Notification Feed, Settings Section, Pipeline Monitor. See
// OrganismsGallerySection.swift for the tab this feeds into, and
// OrganismsMapCommsConfigGalleryB.swift for the remaining five
// Configuration organisms.

import SwiftUI

struct OrganismsMapCommsConfigGalleryA: View {
    var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingMd) {
            GallerySpecimenCard(name: "Map Surface", purpose: "Clustered pins with density overlay", builtFrom: "Map Annotation, Heatmap Layer, Empty State") { MapSurfaceDemo() }
            GallerySpecimenCard(name: "Chat", purpose: "Real-time conversation", builtFrom: "Chat Message, Typing Indicator, Input, Suggestion Menu") { ChatDemo() }
            GallerySpecimenCard(name: "Notification Feed", purpose: "Filterable activity list", builtFrom: "List Row, Chip Row, Empty State") { NotificationFeedDemo() }
            GallerySpecimenCard(name: "Settings Section", purpose: "A group of related settings", builtFrom: "Settings Row, Form Field, Divider, Banner") { SettingsSectionDemo() }
            GallerySpecimenCard(name: "Pipeline Monitor", purpose: "Live stage status and metrics", builtFrom: "List Row, Progress, Badge, Empty State") { PipelineMonitorDemo() }
        }
    }
}

private struct MapSurfaceDemo: View {
    @State private var heatmap = false
    var body: some View {
        MuiMapSurface(
            annotations: [
                MuiMapSurfaceAnnotation(id: "1", x: 0.2, y: 0.3, label: "Reykjavik"),
                MuiMapSurfaceAnnotation(id: "2", x: 0.22, y: 0.31, label: "Reykjavik 2"),
                MuiMapSurfaceAnnotation(id: "3", x: 0.7, y: 0.6, label: "Vik"),
            ],
            heatmapVisible: $heatmap
        )
        .frame(width: 280, height: 200)
    }
}

private struct ChatDemo: View {
    @State private var draft = ""
    var body: some View {
        MuiChat(
            messages: [
                MuiChatMessageData(id: "1", author: "Ada Lovelace", text: "Can you export the Iceland set?", sentAt: Date().addingTimeInterval(-300)),
                MuiChatMessageData(id: "2", author: "You", text: "On it now.", sentAt: Date().addingTimeInterval(-60), own: true),
            ],
            mentionableUsers: [MuiMentionableUser(id: "1", name: "Ada Lovelace")],
            composerValue: $draft
        )
        .frame(width: 280, height: 240)
    }
}

private struct NotificationFeedDemo: View {
    @State private var filter = MuiNotificationFeed.allFilterId
    var body: some View {
        MuiNotificationFeed(
            notifications: [
                MuiNotificationItem(id: "1", label: "Ada mentioned you", category: "mentions", timestamp: Date().addingTimeInterval(-600)),
                MuiNotificationItem(id: "2", label: "Grace shared Iceland 2026", category: "shares", timestamp: Date().addingTimeInterval(-3600), read: true),
            ],
            activeFilterId: $filter
        )
        .frame(width: 260, height: 200)
    }
}

private struct SettingsSectionDemo: View {
    var body: some View {
        MuiSettingsSection(
            title: "Backups",
            rows: [
                .navigate(MuiSettingsNavigableRow(id: "destinations", label: "Destinations", value: "2 configured", icon: "externaldrive")),
                .edit(MuiSettingsEditableRow(id: "schedule", label: "Schedule", icon: "clock", value: "Nightly")),
            ]
        )
        .frame(width: 280)
    }
}

private struct PipelineMonitorDemo: View {
    var body: some View {
        MuiPipelineMonitor(stages: [
            MuiPipelineStage(id: "exif", name: "EXIF", status: .done, processed: 4200, total: 4200),
            MuiPipelineStage(id: "thumb", name: "Thumbnails", status: .running, processed: 3100, total: 4200),
            MuiPipelineStage(id: "geocode", name: "Geocode", status: .error, processed: 0, total: 4200),
        ])
        .frame(width: 280)
    }
}
