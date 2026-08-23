// MuiTodoPopover.swift — Maple UI Molecules-L2 (unified-component-
// catalog.md §3). Task attribute editor, built from Popover, Form Field,
// Chip Row. Anchored to a caller-supplied trigger, same generic-`Trigger`
// shape as the Molecules-L1 overlay menus (MuiSuggestionMenu,
// MuiCommandMenu, MuiContextMenu).

import SwiftUI

public struct MuiTodoPopover<Trigger: View>: View {
    @Binding public var open: Bool
    public let placement: MuiPopoverPlacement
    @Binding public var title: String
    public let priorities: [MuiChip]
    @Binding public var priority: String
    @Binding public var dueLabel: String
    public let saved: (() -> Void)?
    @ViewBuilder public let trigger: Trigger

    public static var defaultPriorities: [MuiChip] {
        [MuiChip(id: "low", label: "Low"), MuiChip(id: "medium", label: "Medium"), MuiChip(id: "high", label: "High")]
    }

    public init(
        open: Binding<Bool>,
        placement: MuiPopoverPlacement = .bottom,
        title: Binding<String>,
        priorities: [MuiChip]? = nil,
        priority: Binding<String>,
        dueLabel: Binding<String>,
        saved: (() -> Void)? = nil,
        @ViewBuilder trigger: () -> Trigger
    ) {
        self._open = open
        self.placement = placement
        self._title = title
        self.priorities = priorities ?? Self.defaultPriorities
        self._priority = priority
        self._dueLabel = dueLabel
        self.saved = saved
        self.trigger = trigger()
    }

    public var body: some View {
        trigger
            .muiPopover(isPresented: open, placement: placement, closeRequested: { open = false }) {
                panel
            }
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
            MuiFormField(label: "Task", value: $title, placeholder: "Ship feature", onCommit: { saved?() })
            MuiChipRow(chips: priorities, mode: .select, selectedId: Binding(get: { priority }, set: { priority = $0 ?? priority }))
            MuiFormField(label: "Due", value: $dueLabel, placeholder: "Fri", onCommit: { saved?() })
        }
        .frame(width: 220)
    }
}

#Preview("MuiTodoPopover") {
    struct Demo: View {
        @State private var open = true
        @State private var title = "Ship feature"
        @State private var priority = "medium"
        @State private var due = "Fri"

        var body: some View {
            MuiTodoPopover(open: $open, title: $title, priority: $priority, dueLabel: $due, saved: {}) {
                MuiButton(label: "Task", variant: .secondary) { open.toggle() }
            }
        }
    }
    return Demo()
        .padding(80)
        .background(MuiTokens.bg)
}
