// MuiEventPopover.swift — Maple UI Molecules-L2 (unified-component-
// catalog.md §3). Calendar event create/edit, built from Popover, Form
// Field, Button. Anchored to a caller-supplied trigger, same generic-
// `Trigger` shape as MuiTodoPopover and the Molecules-L1 overlay menus.

import SwiftUI

public struct MuiEventPopover<Trigger: View>: View {
    @Binding public var open: Bool
    public let placement: MuiPopoverPlacement
    @Binding public var title: String
    @Binding public var timeLabel: String
    public let saved: (() -> Void)?
    public let deleted: (() -> Void)?
    @ViewBuilder public let trigger: Trigger

    public init(
        open: Binding<Bool>,
        placement: MuiPopoverPlacement = .bottom,
        title: Binding<String>,
        timeLabel: Binding<String>,
        saved: (() -> Void)? = nil,
        deleted: (() -> Void)? = nil,
        @ViewBuilder trigger: () -> Trigger
    ) {
        self._open = open
        self.placement = placement
        self._title = title
        self._timeLabel = timeLabel
        self.saved = saved
        self.deleted = deleted
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
            MuiFormField(label: "Title", value: $title, placeholder: "Design review")
            MuiFormField(label: "Time", value: $timeLabel, placeholder: "3:00 PM")
            HStack {
                MuiButton(label: "Delete", variant: .ghost) { deleted?() }
                Spacer()
                MuiButton(label: "Save", variant: .primary) { saved?() }
            }
        }
        .frame(width: 240)
    }
}

#Preview("MuiEventPopover") {
    struct Demo: View {
        @State private var open = true
        @State private var title = "Design review"
        @State private var time = "3:00 PM"

        var body: some View {
            MuiEventPopover(open: $open, title: $title, timeLabel: $time, saved: {}, deleted: {}) {
                MuiButton(label: "Event", variant: .secondary) { open.toggle() }
            }
        }
    }
    return Demo()
        .padding(80)
        .background(MuiTokens.bg)
}
