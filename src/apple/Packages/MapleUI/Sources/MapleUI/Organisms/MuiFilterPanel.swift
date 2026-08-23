// MuiFilterPanel.swift — Maple UI Organisms · Navigation
// (unified-component-catalog.md §4.2). Faceted multi-select filters: one
// collapsible group per facet holding a checkbox list (optionally
// narrowed by a per-group free-text filter), plus a summary chip row of
// the filters currently applied. Built from Collapsible, Chip Row,
// Checkbox, Form Field. Only the first group starts open, to avoid a wall
// of expanded checkboxes on first render.

import SwiftUI

public struct MuiFilterOption: Identifiable, Sendable {
    public let id: String
    public let label: String
    public let checked: Bool

    public init(id: String, label: String, checked: Bool) {
        self.id = id
        self.label = label
        self.checked = checked
    }
}

public struct MuiFilterGroup: Identifiable, Sendable {
    public let id: String
    public let label: String
    public let options: [MuiFilterOption]
    public let searchable: Bool

    public init(id: String, label: String, options: [MuiFilterOption], searchable: Bool = false) {
        self.id = id
        self.label = label
        self.options = options
        self.searchable = searchable
    }
}

public struct MuiFilterPanel: View {
    public let groups: [MuiFilterGroup]
    public let activeChips: [MuiChip]
    public let emptyMessage: String
    public let optionToggled: ((String, String, Bool) -> Void)?
    public let chipRemoved: ((String) -> Void)?

    @State private var openGroupIds: [String] = []
    @State private var groupSearchDrafts: [String: String] = [:]

    public init(
        groups: [MuiFilterGroup],
        activeChips: [MuiChip] = [],
        emptyMessage: String = "No filters available.",
        optionToggled: ((String, String, Bool) -> Void)? = nil,
        chipRemoved: ((String) -> Void)? = nil
    ) {
        self.groups = groups
        self.activeChips = activeChips
        self.emptyMessage = emptyMessage
        self.optionToggled = optionToggled
        self.chipRemoved = chipRemoved
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
            if !activeChips.isEmpty {
                MuiChipRow(chips: activeChips, mode: .removable, removed: { chipRemoved?($0) })
                    .padding(.horizontal, MuiTokens.spacingMd)
                MuiDivider()
            }

            if groups.isEmpty {
                MuiEmptyState(icon: "line.3.horizontal.decrease.circle", title: "No filters", message: emptyMessage)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
                        ForEach(groups) { group in
                            groupView(group)
                        }
                    }
                    .padding(.horizontal, MuiTokens.spacingMd)
                }
            }
        }
        .onAppear {
            if openGroupIds.isEmpty, let first = groups.first {
                openGroupIds = [first.id]
            }
        }
    }

    private func groupView(_ group: MuiFilterGroup) -> some View {
        MuiCollapsible(label: group.label, open: openBinding(for: group.id)) {
            VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
                if group.searchable {
                    MuiFormField(label: "", value: searchBinding(for: group.id), placeholder: "Filter \(group.label.lowercased())…")
                }
                ForEach(Self.visibleOptions(group, draft: groupSearchDrafts[group.id] ?? "")) { option in
                    MuiCheckbox(
                        state: option.checked ? .checked : .unchecked,
                        label: option.label
                    ) {
                        optionToggled?(group.id, option.id, !option.checked)
                    }
                }
            }
        }
    }

    private func openBinding(for id: String) -> Binding<Bool> {
        Binding(
            get: { openGroupIds.contains(id) },
            set: { isOpen in
                openGroupIds = isOpen ? openGroupIds + [id] : openGroupIds.filter { $0 != id }
            }
        )
    }

    private func searchBinding(for groupId: String) -> Binding<String> {
        Binding(
            get: { groupSearchDrafts[groupId] ?? "" },
            set: { groupSearchDrafts[groupId] = $0 }
        )
    }

    // MARK: - Pure logic (unit-testable without a live view)

    /// The options visible for a group given its search draft — every
    /// option when the group isn't searchable or the (trimmed) draft is
    /// empty, otherwise a case-insensitive substring match on the label.
    public static func visibleOptions(_ group: MuiFilterGroup, draft: String) -> [MuiFilterOption] {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard group.searchable, !trimmed.isEmpty else { return group.options }
        let needle = trimmed.lowercased()
        return group.options.filter { $0.label.lowercased().contains(needle) }
    }
}

#Preview("MuiFilterPanel — Populated") {
    MuiFilterPanel(
        groups: [
            MuiFilterGroup(id: "type", label: "File Type", options: [
                MuiFilterOption(id: "raw", label: "RAW", checked: true),
                MuiFilterOption(id: "jpeg", label: "JPEG", checked: false),
            ]),
            MuiFilterGroup(id: "camera", label: "Camera", options: [
                MuiFilterOption(id: "a7", label: "Sony A7 IV", checked: false),
                MuiFilterOption(id: "x100", label: "Fujifilm X100V", checked: false),
            ], searchable: true),
        ],
        activeChips: [MuiChip(id: "type:raw", label: "RAW")]
    )
    .frame(width: 260, height: 320)
    .background(MuiTokens.bg)
}

#Preview("MuiFilterPanel — Empty") {
    MuiFilterPanel(groups: [])
        .frame(width: 260, height: 160)
        .background(MuiTokens.bg)
}
