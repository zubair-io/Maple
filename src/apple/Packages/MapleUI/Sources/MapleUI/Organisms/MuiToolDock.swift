// MuiToolDock.swift — Maple UI Organisms · Navigation
// (unified-component-catalog.md §4.2). Tool group switcher, built from
// Action Button, Divider, Icon. A single-select tool group switcher laid
// out vertically or horizontally. Like Toolbar, this is a thin
// always-populated control — a caller with zero tools passes an empty
// `entries` array and the dock simply renders nothing, no loading/empty
// chrome of its own.

import SwiftUI

public struct MuiToolDockItem: Identifiable, Sendable {
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

public enum MuiToolDockEntry: Sendable {
    case item(MuiToolDockItem)
    case divider
}

public enum MuiToolDockOrientation: Sendable {
    case vertical, horizontal
}

public struct MuiToolDock: View {
    public let entries: [MuiToolDockEntry]
    public let orientation: MuiToolDockOrientation
    @Binding public var activeId: String?
    public let toolSelected: ((String) -> Void)?

    public init(
        entries: [MuiToolDockEntry],
        orientation: MuiToolDockOrientation = .vertical,
        activeId: Binding<String?> = .constant(nil),
        toolSelected: ((String) -> Void)? = nil
    ) {
        self.entries = entries
        self.orientation = orientation
        self._activeId = activeId
        self.toolSelected = toolSelected
    }

    /// A vertical dock stacks icon-over-label per item; a horizontal dock
    /// lays icon and label side by side.
    private var itemOrientation: MuiActionButtonOrientation {
        orientation == .vertical ? .stacked : .horizontal
    }

    private var dividerOrientation: MuiDividerOrientation {
        orientation == .vertical ? .horizontal : .vertical
    }

    public var body: some View {
        let layout = orientation == .vertical ? AnyLayout(VStackLayout(spacing: MuiTokens.spacingXs)) : AnyLayout(HStackLayout(spacing: MuiTokens.spacingXs))
        layout {
            ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                switch entry {
                case .item(let item):
                    MuiActionButton(
                        icon: item.icon,
                        label: item.label,
                        orientation: itemOrientation,
                        selected: item.id == activeId,
                        disabled: item.disabled
                    ) {
                        select(item.id, disabled: item.disabled)
                    }
                case .divider:
                    MuiDivider(orientation: dividerOrientation)
                }
            }
        }
    }

    private func select(_ id: String, disabled: Bool) {
        guard !disabled else { return }
        activeId = id
        toolSelected?(id)
    }
}

#Preview("MuiToolDock — Vertical") {
    struct Demo: View {
        @State private var active: String? = "crop"
        var body: some View {
            MuiToolDock(entries: [
                .item(MuiToolDockItem(id: "crop", icon: "crop", label: "Crop")),
                .item(MuiToolDockItem(id: "adjust", icon: "slider.horizontal.3", label: "Adjust")),
                .divider,
                .item(MuiToolDockItem(id: "heal", icon: "bandage", label: "Heal", disabled: true)),
            ], activeId: $active)
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}

#Preview("MuiToolDock — Horizontal") {
    struct Demo: View {
        @State private var active: String? = "grid"
        var body: some View {
            MuiToolDock(entries: [
                .item(MuiToolDockItem(id: "grid", icon: "square.grid.2x2", label: "Grid")),
                .item(MuiToolDockItem(id: "list", icon: "list.bullet", label: "List")),
            ], orientation: .horizontal, activeId: $active)
            .padding()
            .background(MuiTokens.bg)
        }
    }
    return Demo()
}
