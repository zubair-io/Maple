// MuiSelectivePasteModal.swift — Maple UI Organisms · Modals (unified-
// component-catalog.md §4.4). Per-group apply toggles before pasting
// settings onto other photos, built on Overlay Shell from Checkbox
// (repeated per group), Text, and Button.

import SwiftUI

public struct MuiSelectivePasteGroup: Identifiable, Sendable {
    public let id: String
    public let label: String
    public let description: String?
    public let enabled: Bool

    public init(id: String, label: String, description: String? = nil, enabled: Bool) {
        self.id = id
        self.label = label
        self.description = description
        self.enabled = enabled
    }
}

public struct MuiSelectivePasteModal: View {
    public let isPresented: Bool
    public let contained: Bool
    @Binding public var groups: [MuiSelectivePasteGroup]
    public let pasteConfirmed: (([String]) -> Void)?
    public let dismissed: (() -> Void)?

    public init(
        isPresented: Bool,
        contained: Bool = false,
        groups: Binding<[MuiSelectivePasteGroup]>,
        pasteConfirmed: (([String]) -> Void)? = nil,
        dismissed: (() -> Void)? = nil
    ) {
        self.isPresented = isPresented
        self.contained = contained
        self._groups = groups
        self.pasteConfirmed = pasteConfirmed
        self.dismissed = dismissed
    }

    private var enabledCount: Int {
        groups.filter(\.enabled).count
    }

    public var body: some View {
        MuiOverlayShell(isPresented: isPresented, accessibilityLabel: "Selective Paste", contained: contained) {
            MuiText("Selective Paste", variant: .sheetTitle)
        } content: {
            VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                MuiText("\(enabledCount) of \(groups.count) groups will be applied.", variant: .body, color: .muted)
                ForEach(groups) { group in
                    VStack(alignment: .leading, spacing: 2) {
                        MuiCheckbox(state: group.enabled ? .checked : .unchecked, label: group.label) { toggle(group.id) }
                        if let description = group.description {
                            MuiText(description, variant: .body, color: .muted)
                                .padding(.leading, 28)
                        }
                    }
                }
            }
        } footer: {
            HStack {
                Spacer()
                MuiButton(label: "Cancel", variant: .ghost) { dismissed?() }
                MuiButton(label: "Paste", variant: .primary) { confirmPaste() }
            }
        } dismissed: {
            dismissed?()
        }
    }

    private func toggle(_ groupId: String) {
        guard let idx = groups.firstIndex(where: { $0.id == groupId }) else { return }
        let group = groups[idx]
        groups[idx] = MuiSelectivePasteGroup(id: group.id, label: group.label, description: group.description, enabled: !group.enabled)
    }

    private func confirmPaste() {
        pasteConfirmed?(groups.filter(\.enabled).map(\.id))
    }
}

#Preview("MuiSelectivePasteModal") {
    struct Demo: View {
        @State private var open = false
        @State private var groups = [
            MuiSelectivePasteGroup(id: "light", label: "Light", description: "Exposure, contrast, highlights", enabled: true),
            MuiSelectivePasteGroup(id: "color", label: "Color", description: "White balance, HSL", enabled: false),
        ]
        var body: some View {
            ZStack {
                MuiTokens.bg
                MuiButton(label: "Open Selective Paste", variant: .primary) { open = true }
                MuiSelectivePasteModal(isPresented: open, groups: $groups, dismissed: { open = false })
            }
            .frame(width: 380, height: 300)
        }
    }
    return Demo()
}
