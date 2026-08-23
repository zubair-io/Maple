// MuiVersionHistoryPanel.swift — Maple UI Organisms · Inspectors & panels
// (unified-component-catalog.md §4.3). Browse and restore versions, built
// from List Row, Timestamp, Button, Dialog. Mirrors Presets Panel's
// confirm-then-emit shape: `restored` only fires after the confirm
// dialog round-trips, never straight off the row press.

import SwiftUI

public struct MuiVersionItem: Identifiable, Sendable {
    public let id: String
    public let label: String
    public let timestampValue: Date
    public let current: Bool

    public init(id: String, label: String, timestampValue: Date, current: Bool = false) {
        self.id = id
        self.label = label
        self.timestampValue = timestampValue
        self.current = current
    }
}

public struct MuiVersionHistoryPanel: View {
    public let versions: [MuiVersionItem]
    public let loading: Bool
    public let restored: ((String) -> Void)?

    @State private var pendingRestoreId: String?

    public init(versions: [MuiVersionItem], loading: Bool = false, restored: ((String) -> Void)? = nil) {
        self.versions = versions
        self.loading = loading
        self.restored = restored
    }

    public var body: some View {
        ZStack {
            Group {
                if loading {
                    MuiSpinner(placement: .centered, label: "Loading versions")
                } else if versions.isEmpty {
                    MuiEmptyState(icon: "clock.arrow.circlepath", title: "No versions", message: "Every edit will show up here.")
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(versions) { version in
                                MuiListRow(label: version.label, timestampValue: version.timestampValue, active: version.current, trailing: {
                                    if version.current {
                                        MuiBadge(variant: .signal, value: "Current")
                                    } else {
                                        MuiButton(label: "Restore", variant: .ghost, size: .sm) { pendingRestoreId = version.id }
                                    }
                                })
                            }
                        }
                    }
                }
            }

            MuiDialog(
                isPresented: pendingRestoreId != nil,
                title: "Restore this version?",
                message: "Your current edits will be replaced.",
                variant: .confirm,
                confirmLabel: "Restore",
                confirmed: { _ in confirmRestore() },
                dismissed: { pendingRestoreId = nil }
            )
        }
    }

    private func confirmRestore() {
        if let id = pendingRestoreId { restored?(id) }
        pendingRestoreId = nil
    }
}

#Preview("MuiVersionHistoryPanel") {
    MuiVersionHistoryPanel(versions: [
        MuiVersionItem(id: "1", label: "Current edit", timestampValue: Date(), current: true),
        MuiVersionItem(id: "2", label: "Before color grade", timestampValue: Date().addingTimeInterval(-3600)),
        MuiVersionItem(id: "3", label: "Original import", timestampValue: Date().addingTimeInterval(-86400)),
    ])
    .frame(width: 280, height: 220)
    .background(MuiTokens.bg)
}

#Preview("MuiVersionHistoryPanel — Loading / Empty") {
    VStack(spacing: 0) {
        MuiVersionHistoryPanel(versions: [], loading: true).frame(height: 100)
        MuiDivider()
        MuiVersionHistoryPanel(versions: []).frame(height: 140)
    }
    .background(MuiTokens.bg)
}
