// MuiBubbleMenu.swift — Maple UI Molecules-L1 (unified-component-
// catalog.md §2.5; Built from: Icon, Divider). A floating contextual
// format bar (e.g. a text-selection bold/italic/link toolbar), anchored
// via MuiPopover — same open/placement/closeRequested contract as the
// other overlay molecules.

import SwiftUI

public struct MuiBubbleMenuItem: Identifiable, Sendable {
    public let id: String
    public let icon: String
    public let label: String
    public let active: Bool

    public init(id: String, icon: String, label: String, active: Bool = false) {
        self.id = id
        self.icon = icon
        self.label = label
        self.active = active
    }
}

public enum MuiBubbleMenuEntry: Sendable {
    case item(MuiBubbleMenuItem)
    case divider
}

public struct MuiBubbleMenu<Trigger: View>: View {
    @Binding public var open: Bool
    public let placement: MuiPopoverPlacement
    public let entries: [MuiBubbleMenuEntry]
    public let itemSelected: (String) -> Void
    @ViewBuilder public let trigger: Trigger

    public init(
        open: Binding<Bool>,
        placement: MuiPopoverPlacement = .top,
        entries: [MuiBubbleMenuEntry],
        itemSelected: @escaping (String) -> Void,
        @ViewBuilder trigger: () -> Trigger
    ) {
        self._open = open
        self.placement = placement
        self.entries = entries
        self.itemSelected = itemSelected
        self.trigger = trigger()
    }

    public var body: some View {
        trigger
            .muiPopover(isPresented: open, placement: placement, closeRequested: { open = false }) {
                HStack(spacing: MuiTokens.spacingXs) {
                    ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                        switch entry {
                        case .item(let item):
                            Button {
                                itemSelected(item.id)
                            } label: {
                                MuiIcon(
                                    name: item.icon,
                                    size: .sm,
                                    color: item.active ? MuiTokens.primary : MuiTokens.textMuted
                                )
                                .padding(MuiTokens.spacingXs)
                                .background(
                                    item.active ? MuiTokens.primaryDim : .clear,
                                    in: RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous)
                                )
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(item.label)
                        case .divider:
                            MuiDivider(orientation: .vertical).frame(height: 16)
                        }
                    }
                }
            }
    }
}

#Preview("MuiBubbleMenu") {
    struct Demo: View {
        @State private var open = true

        var body: some View {
            MuiBubbleMenu(
                open: $open,
                entries: [
                    .item(MuiBubbleMenuItem(id: "bold", icon: "bold", label: "Bold", active: true)),
                    .item(MuiBubbleMenuItem(id: "italic", icon: "italic", label: "Italic")),
                    .divider,
                    .item(MuiBubbleMenuItem(id: "link", icon: "link", label: "Link")),
                ],
                itemSelected: { _ in }
            ) {
                Rectangle().fill(MuiTokens.surfaceAlt).frame(width: 160, height: 60)
            }
        }
    }
    return Demo()
        .padding(80)
        .background(MuiTokens.bg)
}
