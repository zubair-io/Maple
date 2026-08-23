// MuiSuggestionMenu.swift — Maple UI Molecules-L1 (unified-component-
// catalog.md §2.4; Built from: Popover, Icon, Text). A query-driven
// autocomplete list (e.g. an @-mention picker) — the caller already
// filters `items` by the live query text; this component owns only the
// anchored presentation and keyboard/mouse selection.

import SwiftUI

public struct MuiSuggestionItem: Identifiable, Sendable {
    public let id: String
    public let label: String
    public let icon: String?
    public let meta: String?

    public init(id: String, label: String, icon: String? = nil, meta: String? = nil) {
        self.id = id
        self.label = label
        self.icon = icon
        self.meta = meta
    }
}

public struct MuiSuggestionMenu<Trigger: View>: View {
    @Binding public var open: Bool
    public let placement: MuiPopoverPlacement
    public let items: [MuiSuggestionItem]
    public let select: (String) -> Void
    @ViewBuilder public let trigger: Trigger

    @State private var activeIndex = 0

    public init(
        open: Binding<Bool>,
        placement: MuiPopoverPlacement = .bottom,
        items: [MuiSuggestionItem],
        select: @escaping (String) -> Void,
        @ViewBuilder trigger: () -> Trigger
    ) {
        self._open = open
        self.placement = placement
        self.items = items
        self.select = select
        self.trigger = trigger()
    }

    public var body: some View {
        trigger
            .muiPopover(isPresented: open, placement: placement, closeRequested: { open = false }) {
                menu
            }
            // A freshly (re)opened or re-filtered list always highlights
            // its first row, matching the usual @-mention/autocomplete
            // convention of "Enter picks the top match".
            .onChange(of: open) { _, isOpen in if isOpen { activeIndex = 0 } }
            .onChange(of: items.map(\.id)) { activeIndex = 0 }
    }

    private var menu: some View {
        VStack(alignment: .leading, spacing: 2) {
            if items.isEmpty {
                MuiText("No matches", variant: .body, color: .muted)
                    .padding(.horizontal, MuiTokens.spacingSm)
                    .padding(.vertical, MuiTokens.spacingXs)
            }
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                row(item, index: index)
            }
        }
        .frame(minWidth: 200)
        #if os(macOS)
        .focusable()
        .onKeyPress(.downArrow) { moveActive(1); return .handled }
        .onKeyPress(.upArrow) { moveActive(-1); return .handled }
        .onKeyPress(.return) { activateHighlighted(); return .handled }
        #endif
    }

    private func row(_ item: MuiSuggestionItem, index: Int) -> some View {
        Button {
            select(item.id)
            open = false
        } label: {
            HStack(spacing: MuiTokens.spacingSm) {
                if let icon = item.icon {
                    MuiIcon(name: icon, size: .sm, color: MuiTokens.textMuted)
                }
                MuiText(item.label, variant: .rowLabel)
                Spacer(minLength: MuiTokens.spacingSm)
                if let meta = item.meta {
                    MuiText(meta, variant: .body, color: .muted)
                }
            }
            .padding(.horizontal, MuiTokens.spacingSm)
            .padding(.vertical, MuiTokens.spacingXs)
            .frame(minHeight: 32)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                index == activeIndex ? MuiTokens.surfaceHover : .clear,
                in: RoundedRectangle(cornerRadius: MuiTokens.radiusSm, style: .continuous)
            )
        }
        .buttonStyle(.plain)
    }

    private func moveActive(_ direction: Int) {
        activeIndex = MuiMenuNavMath.wrappedIndex(current: activeIndex, direction: direction, count: items.count)
    }

    private func activateHighlighted() {
        guard items.indices.contains(activeIndex) else { return }
        select(items[activeIndex].id)
        open = false
    }
}

#Preview("MuiSuggestionMenu") {
    struct Demo: View {
        @State private var open = false

        var body: some View {
            MuiSuggestionMenu(
                open: $open,
                items: [
                    MuiSuggestionItem(id: "ada", label: "Ada Lovelace", icon: "person.crop.circle"),
                    MuiSuggestionItem(id: "grace", label: "Grace Hopper", icon: "person.crop.circle"),
                    MuiSuggestionItem(id: "kat", label: "Katherine Johnson", icon: "person.crop.circle"),
                ],
                select: { _ in }
            ) {
                MuiButton(label: "@mention", variant: .secondary) { open.toggle() }
            }
        }
    }
    return Demo()
        .padding(80)
        .background(MuiTokens.bg)
}
