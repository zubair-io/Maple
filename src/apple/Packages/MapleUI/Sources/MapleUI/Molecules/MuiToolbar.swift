// MuiToolbar.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.5; Built from: Action Button, Divider, Icon). A row of action
// buttons; once the item entries exceed `maxVisible` the rest collapse
// behind a trailing overflow button that opens a popover list.

import SwiftUI

public struct MuiToolbarActionItem: Identifiable, Sendable {
    public let id: String
    public let icon: String
    public let label: String
    public let disabled: Bool

    public init(id: String, icon: String, label: String, disabled: Bool = false) {
        self.id = id
        self.icon = icon
        self.label = label
        self.disabled = disabled
    }
}

public enum MuiToolbarEntry: Sendable {
    case item(MuiToolbarActionItem)
    case divider
}

public struct MuiToolbar: View {
    public let entries: [MuiToolbarEntry]
    /// Item entries beyond this count move into the overflow popover.
    /// Dividers don't count against the budget.
    public let maxVisible: Int
    public let itemSelected: (String) -> Void

    @State private var overflowOpen = false

    public init(entries: [MuiToolbarEntry], maxVisible: Int = .max, itemSelected: @escaping (String) -> Void) {
        self.entries = entries
        self.maxVisible = maxVisible
        self.itemSelected = itemSelected
    }

    /// Splits `entries` into the visible row and the overflow list — a
    /// divider only earns its place while still filling the visible row;
    /// once overflow has started, trailing dividers add nothing to either
    /// list. Public + static so this is unit-testable without rendering a
    /// view.
    public static func split(
        entries: [MuiToolbarEntry],
        maxVisible: Int
    ) -> (visible: [MuiToolbarEntry], overflow: [MuiToolbarActionItem]) {
        var visible: [MuiToolbarEntry] = []
        var overflow: [MuiToolbarActionItem] = []
        var itemCount = 0
        for entry in entries {
            switch entry {
            case .item(let item):
                if itemCount < maxVisible {
                    visible.append(entry)
                    itemCount += 1
                } else {
                    overflow.append(item)
                }
            case .divider:
                if overflow.isEmpty { visible.append(entry) }
            }
        }
        return (visible, overflow)
    }

    public var body: some View {
        let split = Self.split(entries: entries, maxVisible: maxVisible)

        HStack(spacing: MuiTokens.spacingXs) {
            ForEach(Array(split.visible.enumerated()), id: \.offset) { _, entry in
                switch entry {
                case .item(let item):
                    MuiActionButton(icon: item.icon, label: item.label, size: .sm, disabled: item.disabled) {
                        press(item)
                    }
                case .divider:
                    MuiDivider(orientation: .vertical).frame(height: 20)
                }
            }

            if !split.overflow.isEmpty {
                MuiActionButton(icon: "ellipsis", label: "More", size: .sm) {
                    overflowOpen.toggle()
                }
                .muiPopover(isPresented: overflowOpen, placement: .bottom, closeRequested: { overflowOpen = false }) {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(split.overflow) { item in
                            Button {
                                selectOverflow(item)
                            } label: {
                                HStack(spacing: MuiTokens.spacingSm) {
                                    MuiIcon(name: item.icon, size: .sm, color: MuiTokens.textMuted)
                                    MuiText(item.label, variant: .rowLabel)
                                    Spacer(minLength: MuiTokens.spacingSm)
                                }
                                .padding(.horizontal, MuiTokens.spacingSm)
                                .padding(.vertical, MuiTokens.spacingXs)
                                .frame(minHeight: 32)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                            .disabled(item.disabled)
                            .opacity(item.disabled ? 0.45 : 1)
                        }
                    }
                    .frame(minWidth: 160)
                }
            }
        }
    }

    private func press(_ item: MuiToolbarActionItem) {
        guard !item.disabled else { return }
        itemSelected(item.id)
    }

    private func selectOverflow(_ item: MuiToolbarActionItem) {
        guard !item.disabled else { return }
        itemSelected(item.id)
        overflowOpen = false
    }
}

#Preview("MuiToolbar") {
    VStack(spacing: 16) {
        MuiToolbar(
            entries: [
                .item(MuiToolbarActionItem(id: "crop", icon: "crop", label: "Crop")),
                .item(MuiToolbarActionItem(id: "rotate", icon: "rotate.right", label: "Rotate")),
                .divider,
                .item(MuiToolbarActionItem(id: "export", icon: "square.and.arrow.up", label: "Export")),
            ],
            itemSelected: { _ in }
        )

        MuiToolbar(
            entries: [
                .item(MuiToolbarActionItem(id: "crop", icon: "crop", label: "Crop")),
                .item(MuiToolbarActionItem(id: "rotate", icon: "rotate.right", label: "Rotate")),
                .item(MuiToolbarActionItem(id: "export", icon: "square.and.arrow.up", label: "Export")),
                .item(MuiToolbarActionItem(id: "share", icon: "person.2", label: "Share")),
            ],
            maxVisible: 2,
            itemSelected: { _ in }
        )
    }
    .padding(80)
    .background(MuiTokens.bg)
}
