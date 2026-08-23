// MuiCommandMenu.swift — Maple UI Molecules-L1 (unified-component-
// catalog.md §2.4; Built from: Popover, Input, Icon, Text). A searchable
// command palette: an MuiInput filter on top of an anchored MuiPopover
// result list, filtering by substring match against each command's label.

import SwiftUI

public struct MuiCommandItem: Identifiable, Sendable {
    public let id: String
    public let label: String
    public let icon: String?
    public let shortcut: String?

    public init(id: String, label: String, icon: String? = nil, shortcut: String? = nil) {
        self.id = id
        self.label = label
        self.icon = icon
        self.shortcut = shortcut
    }
}

public struct MuiCommandMenu<Trigger: View>: View {
    @Binding public var open: Bool
    public let placement: MuiPopoverPlacement
    public let commands: [MuiCommandItem]
    public let placeholder: String
    public let select: (String) -> Void
    @ViewBuilder public let trigger: Trigger

    @State private var query = ""
    @State private var activeIndex = 0

    public init(
        open: Binding<Bool>,
        placement: MuiPopoverPlacement = .bottom,
        commands: [MuiCommandItem],
        placeholder: String = "Type a command",
        select: @escaping (String) -> Void,
        @ViewBuilder trigger: () -> Trigger
    ) {
        self._open = open
        self.placement = placement
        self.commands = commands
        self.placeholder = placeholder
        self.select = select
        self.trigger = trigger()
    }

    private var filtered: [MuiCommandItem] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return commands }
        return commands.filter { $0.label.lowercased().contains(q) }
    }

    private var clampedActiveIndex: Int {
        MuiMenuNavMath.clampedIndex(activeIndex, count: filtered.count)
    }

    public var body: some View {
        trigger
            .muiPopover(isPresented: open, placement: placement, closeRequested: { open = false }) {
                menu
            }
            // Every (re)open starts from a clean search, same as a real
            // command palette — the previous query never survives a close.
            .onChange(of: open) { _, isOpen in
                if isOpen {
                    query = ""
                    activeIndex = 0
                }
            }
    }

    private var menu: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingXs) {
            MuiInput(value: $query, accessibilityLabel: placeholder, placeholder: placeholder, prefixIcon: "magnifyingglass")
                .onChange(of: query) { activeIndex = 0 }

            if filtered.isEmpty {
                MuiText("No commands found", variant: .body, color: .muted)
                    .padding(.horizontal, MuiTokens.spacingSm)
                    .padding(.vertical, MuiTokens.spacingXs)
            }

            ForEach(Array(filtered.enumerated()), id: \.element.id) { index, command in
                row(command, index: index)
            }
        }
        .frame(minWidth: 240)
        #if os(macOS)
        .focusable()
        .onKeyPress(.downArrow) { moveActive(1); return .handled }
        .onKeyPress(.upArrow) { moveActive(-1); return .handled }
        .onKeyPress(.return) { activateHighlighted(); return .handled }
        #endif
    }

    private func row(_ command: MuiCommandItem, index: Int) -> some View {
        Button {
            select(command.id)
            open = false
        } label: {
            HStack(spacing: MuiTokens.spacingSm) {
                if let icon = command.icon {
                    MuiIcon(name: icon, size: .sm, color: MuiTokens.textMuted)
                }
                MuiText(command.label, variant: .rowLabel)
                Spacer(minLength: MuiTokens.spacingSm)
                if let shortcut = command.shortcut {
                    MuiText(shortcut, variant: .toolLabel, color: .muted)
                }
            }
            .padding(.horizontal, MuiTokens.spacingSm)
            .padding(.vertical, MuiTokens.spacingXs)
            .frame(minHeight: 32)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                index == clampedActiveIndex ? MuiTokens.surfaceHover : .clear,
                in: RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous)
            )
        }
        .buttonStyle(.plain)
    }

    private func moveActive(_ direction: Int) {
        guard !filtered.isEmpty else { return }
        activeIndex = MuiMenuNavMath.wrappedIndex(current: clampedActiveIndex, direction: direction, count: filtered.count)
    }

    private func activateHighlighted() {
        let index = clampedActiveIndex
        guard filtered.indices.contains(index) else { return }
        select(filtered[index].id)
        open = false
    }
}

#Preview("MuiCommandMenu") {
    struct Demo: View {
        @State private var open = false

        var body: some View {
            MuiCommandMenu(
                open: $open,
                commands: [
                    MuiCommandItem(id: "export", label: "Export…", icon: "square.and.arrow.up", shortcut: "⌘E"),
                    MuiCommandItem(id: "rename", label: "Batch Rename…", icon: "pencil"),
                    MuiCommandItem(id: "crop", label: "Crop", icon: "crop", shortcut: "C"),
                ],
                select: { _ in }
            ) {
                MuiButton(label: "Command palette", variant: .secondary, leadingIcon: "command") { open.toggle() }
            }
        }
    }
    return Demo()
        .padding(80)
        .background(MuiTokens.bg)
}
