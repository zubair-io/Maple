// MuiContextMenu.swift — Maple UI Molecules-L1 (unified-component-catalog.md
// §2.4; Built from: Popover, Icon, Text, Divider). A keyboard-navigable
// action list anchored via MuiPopover; the caller supplies the trigger
// content and owns `open` state, same contract as the underlying Popover.

import SwiftUI

public struct MuiContextMenuItem: Identifiable, Sendable {
    public let id: String
    public let label: String
    public let icon: String?
    public let disabled: Bool
    public let destructive: Bool

    public init(id: String, label: String, icon: String? = nil, disabled: Bool = false, destructive: Bool = false) {
        self.id = id
        self.label = label
        self.icon = icon
        self.disabled = disabled
        self.destructive = destructive
    }
}

public enum MuiContextMenuEntry: Sendable {
    case item(MuiContextMenuItem)
    case divider
}

public struct MuiContextMenu<Trigger: View>: View {
    @Binding public var open: Bool
    public let placement: MuiPopoverPlacement
    public let entries: [MuiContextMenuEntry]
    public let select: (String) -> Void
    @ViewBuilder public let trigger: Trigger

    @State private var activeId: String?

    public init(
        open: Binding<Bool>,
        placement: MuiPopoverPlacement = .bottom,
        entries: [MuiContextMenuEntry],
        select: @escaping (String) -> Void,
        @ViewBuilder trigger: () -> Trigger
    ) {
        self._open = open
        self.placement = placement
        self.entries = entries
        self.select = select
        self.trigger = trigger()
    }

    public var body: some View {
        trigger
            .muiPopover(isPresented: open, placement: placement, closeRequested: close) {
                menu
            }
            .onChange(of: open) { _, isOpen in
                // A freshly (re)opened menu starts with no keyboard-active
                // row — the previous session's highlight must not leak
                // into the next open.
                if isOpen { activeId = nil }
            }
    }

    private var menu: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(entries.enumerated()), id: \.offset) { index, entry in
                switch entry {
                case .item(let item):
                    row(item, index: index)
                case .divider:
                    MuiDivider()
                        .padding(.vertical, 2)
                }
            }
        }
        .frame(minWidth: 180)
        #if os(macOS)
        .focusable()
        .onKeyPress(.downArrow) { move(1); return .handled }
        .onKeyPress(.upArrow) { move(-1); return .handled }
        .onKeyPress(.return) { activateHighlighted(); return .handled }
        #endif
    }

    private func row(_ item: MuiContextMenuItem, index: Int) -> some View {
        Button {
            guard !item.disabled else { return }
            select(item.id)
            close()
        } label: {
            HStack(spacing: MuiTokens.spacingSm) {
                if let icon = item.icon {
                    MuiIcon(name: icon, size: .sm, color: item.destructive ? MuiTokens.errorText : MuiTokens.textMuted)
                }
                MuiText(item.label, variant: .rowLabel, color: item.destructive ? .error : .main)
                Spacer(minLength: MuiTokens.spacingSm)
            }
            .padding(.horizontal, MuiTokens.spacingSm)
            .padding(.vertical, MuiTokens.spacingXs)
            .frame(minHeight: 32)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                activeId == item.id ? MuiTokens.surfaceHover : .clear,
                in: RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous)
            )
        }
        .buttonStyle(.plain)
        .disabled(item.disabled)
        .opacity(item.disabled ? 0.45 : 1)
        .accessibilityAddTraits(.isButton)
    }

    private func selectableIds() -> [Int] {
        entries.enumerated().compactMap { index, entry -> Int? in
            if case .item(let item) = entry, !item.disabled { return index }
            return nil
        }
    }

    private func move(_ direction: Int) {
        let selectable = selectableIds()
        let currentIndex = activeId.flatMap { id in entries.firstIndex { if case .item(let i) = $0 { return i.id == id } else { return false } } }
        let nextIndex = MuiMenuNavMath.moveActive(current: currentIndex, direction: direction, selectable: selectable)
        if let nextIndex, case .item(let item) = entries[nextIndex] {
            activeId = item.id
        }
    }

    private func activateHighlighted() {
        guard let activeId, let entry = entries.first(where: { if case .item(let i) = $0 { return i.id == activeId } else { return false } }),
              case .item(let item) = entry else { return }
        select(item.id)
        close()
    }

    private func close() {
        open = false
    }
}

#Preview("MuiContextMenu") {
    struct Demo: View {
        @State private var open = false

        var body: some View {
            MuiContextMenu(
                open: $open,
                entries: [
                    .item(MuiContextMenuItem(id: "rename", label: "Rename", icon: "pencil")),
                    .item(MuiContextMenuItem(id: "duplicate", label: "Duplicate", icon: "plus.square.on.square")),
                    .divider,
                    .item(MuiContextMenuItem(id: "locked", label: "Locked action", icon: "lock", disabled: true)),
                    .item(MuiContextMenuItem(id: "delete", label: "Delete", icon: "trash", destructive: true)),
                ],
                select: { _ in }
            ) {
                MuiButton(label: "Actions", variant: .secondary, trailingIcon: "chevron.down") { open.toggle() }
            }
        }
    }
    return Demo()
        .padding(80)
        .background(MuiTokens.bg)
}
