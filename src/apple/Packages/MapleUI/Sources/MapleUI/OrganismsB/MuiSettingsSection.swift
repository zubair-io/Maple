// MuiSettingsSection.swift — Maple UI Organisms · Configuration
// (unified-component-catalog.md §4.8). A titled group of related settings
// rows, built from Settings Row, Form Field, Divider, Banner.
//
// Rows come in two flavors, modeled as an enum rather than one row shape
// with optional fields: `.navigate` hands off to another screen (rendered
// as a `MuiListRow`), and `.edit` expands in place to reveal an inline
// `MuiFormField` (rendered as a `MuiSettingsRow`, whose Collapsible body is
// exactly that expand-to-edit affordance).

import SwiftUI

public struct MuiSettingsNavigableRow: Identifiable, Sendable {
    public let id: String
    public let label: String
    public let value: String?
    public let icon: String?
    public let disabled: Bool

    public init(id: String, label: String, value: String? = nil, icon: String? = nil, disabled: Bool = false) {
        self.id = id
        self.label = label
        self.value = value
        self.icon = icon
        self.disabled = disabled
    }
}

public struct MuiSettingsEditableRow: Identifiable, Sendable {
    public let id: String
    public let label: String
    public let description: String?
    public let icon: String?
    public let value: String
    public let placeholder: String
    public let help: String?

    public init(id: String, label: String, description: String? = nil, icon: String? = nil, value: String, placeholder: String = "", help: String? = nil) {
        self.id = id
        self.label = label
        self.description = description
        self.icon = icon
        self.value = value
        self.placeholder = placeholder
        self.help = help
    }
}

public enum MuiSettingsSectionRow: Identifiable, Sendable {
    case navigate(MuiSettingsNavigableRow)
    case edit(MuiSettingsEditableRow)

    public var id: String {
        switch self {
        case .navigate(let row): return row.id
        case .edit(let row): return row.id
        }
    }
}

public struct MuiSettingsSectionBanner: Sendable {
    public let message: String
    public let variant: MuiBannerVariant

    public init(message: String, variant: MuiBannerVariant) {
        self.message = message
        self.variant = variant
    }
}

public struct MuiSettingsSection: View {
    public let title: String
    public let rows: [MuiSettingsSectionRow]
    public let banner: MuiSettingsSectionBanner?
    public let rowActivated: ((String) -> Void)?
    public let fieldChanged: ((String, String) -> Void)?

    @State private var openRowIds: Set<String> = []

    public init(
        title: String,
        rows: [MuiSettingsSectionRow],
        banner: MuiSettingsSectionBanner? = nil,
        rowActivated: ((String) -> Void)? = nil,
        fieldChanged: ((String, String) -> Void)? = nil
    ) {
        self.title = title
        self.rows = rows
        self.banner = banner
        self.rowActivated = rowActivated
        self.fieldChanged = fieldChanged
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
            MuiText(title, variant: .eyebrow, color: .muted)

            if let banner {
                MuiBanner(variant: banner.variant, message: banner.message)
            }

            VStack(spacing: 0) {
                ForEach(rows) { row in
                    rowView(row)
                }
            }
            .background(MuiTokens.surface, in: RoundedRectangle(cornerRadius: MuiTokens.radiusLg, style: .continuous))
        }
    }

    @ViewBuilder
    private func rowView(_ row: MuiSettingsSectionRow) -> some View {
        switch row {
        case .navigate(let navRow):
            MuiListRow(
                icon: navRow.icon, label: navRow.label, subtitle: navRow.value,
                disabled: navRow.disabled, pressed: { rowActivated?(navRow.id) }
            ) {
                MuiIcon(name: "chevron.right", size: .sm, color: MuiTokens.textMuted)
            }
        case .edit(let editRow):
            MuiSettingsRow(
                label: editRow.label, icon: editRow.icon, description: editRow.description,
                open: Binding(get: { openRowIds.contains(editRow.id) }, set: { toggle(editRow.id, open: $0) })
            ) {
                MuiFormField(
                    label: editRow.label, value: Binding(get: { editRow.value }, set: { fieldChanged?(editRow.id, $0) }),
                    placeholder: editRow.placeholder, help: editRow.help
                )
            }
        }
    }

    private func toggle(_ id: String, open: Bool) {
        if open { openRowIds.insert(id) } else { openRowIds.remove(id) }
    }
}

#Preview("MuiSettingsSection") {
    MuiSettingsSection(
        title: "Backups",
        rows: [
            .navigate(MuiSettingsNavigableRow(id: "destinations", label: "Destinations", value: "2 configured", icon: "externaldrive")),
            .edit(MuiSettingsEditableRow(id: "schedule", label: "Schedule", description: "How often backups run.", icon: "clock", value: "Nightly")),
        ],
        banner: MuiSettingsSectionBanner(message: "Last backup completed 2 hours ago.", variant: .success)
    )
    .padding()
    .frame(width: 320)
    .background(MuiTokens.bg)
}
