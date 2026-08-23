// MuiSidebar.swift — Maple UI Organisms · Navigation
// (unified-component-catalog.md §4.2). Hierarchical source/page tree,
// built from Tree Row, Toolbar, Collapsible, Context Menu, Empty State.
// Labeled sections (e.g. "MAPLE CLOUD" / "LOCAL"), each holding a node
// tree that flattens to depth-indented rows for render — a collapsed
// branch simply drops its children from the flattened list rather than
// nesting a separate Collapsible per branch, same shape as the web
// reference's `flatten()`.

import SwiftUI

public struct MuiSidebarNode: Identifiable, Sendable {
    public let id: String
    public let label: String
    public let icon: String
    public let count: Int?
    public let children: [MuiSidebarNode]?

    public init(id: String, label: String, icon: String = "folder", count: Int? = nil, children: [MuiSidebarNode]? = nil) {
        self.id = id
        self.label = label
        self.icon = icon
        self.count = count
        self.children = children
    }
}

public struct MuiSidebarSection: Identifiable, Sendable {
    public let id: String
    public let label: String
    public let nodes: [MuiSidebarNode]

    public init(id: String, label: String, nodes: [MuiSidebarNode]) {
        self.id = id
        self.label = label
        self.nodes = nodes
    }
}

/// One flattened, depth-indented row — the render unit `flatten(_:)`
/// produces from a `MuiSidebarNode` tree.
public struct MuiSidebarFlatRow: Identifiable, Sendable {
    public var id: String { node.id }
    public let node: MuiSidebarNode
    public let depth: Int
}

public struct MuiSidebar: View {
    public let sections: [MuiSidebarSection]
    public let toolbarEntries: [MuiToolbarEntry]
    public let contextMenuEntries: [MuiContextMenuItem]
    public let loading: Bool
    @Binding public var activeId: String?
    @Binding public var expandedIds: [String]
    public let toolbarAction: ((String) -> Void)?
    public let contextAction: ((String, String) -> Void)?

    @State private var contextMenuNodeId: String?
    @State private var contextMenuOpen = false

    public init(
        sections: [MuiSidebarSection],
        toolbarEntries: [MuiToolbarEntry] = [],
        contextMenuEntries: [MuiContextMenuItem] = [],
        loading: Bool = false,
        activeId: Binding<String?> = .constant(nil),
        expandedIds: Binding<[String]> = .constant([]),
        toolbarAction: ((String) -> Void)? = nil,
        contextAction: ((String, String) -> Void)? = nil
    ) {
        self.sections = sections
        self.toolbarEntries = toolbarEntries
        self.contextMenuEntries = contextMenuEntries
        self.loading = loading
        self._activeId = activeId
        self._expandedIds = expandedIds
        self.toolbarAction = toolbarAction
        self.contextAction = contextAction
    }

    private var isEmpty: Bool {
        sections.allSatisfy { $0.nodes.isEmpty }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !toolbarEntries.isEmpty {
                MuiToolbar(entries: toolbarEntries) { toolbarAction?($0) }
                    .padding(.horizontal, MuiTokens.spacingSm)
                    .padding(.vertical, MuiTokens.spacingXs)
                MuiDivider()
            }

            if loading {
                MuiSpinner(placement: .centered, label: "Loading sources")
            } else if sections.isEmpty || isEmpty {
                MuiEmptyState(icon: "tray", title: "Nothing to show", message: "No sources connected yet.")
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                        ForEach(sections) { section in
                            sectionView(section)
                        }
                    }
                    .padding(.vertical, MuiTokens.spacingSm)
                }
            }
        }
        .background(MuiTokens.sidebar)
    }

    private func sectionView(_ section: MuiSidebarSection) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            MuiText(section.label, variant: .eyebrow, color: .muted)
                .padding(.horizontal, MuiTokens.spacingMd)
            ForEach(Self.flatten(section.nodes, depth: 0, expandedIds: expandedIds)) { row in
                rowView(row)
            }
        }
    }

    private func rowView(_ row: MuiSidebarFlatRow) -> some View {
        MuiContextMenu(
            open: contextMenuBinding(for: row.node.id),
            entries: contextMenuEntries.map { .item($0) },
            select: { actionId in contextAction?(row.node.id, actionId) }
        ) {
            MuiTreeRow(
                label: row.node.label,
                icon: row.node.icon,
                expandable: row.node.children?.isEmpty == false,
                expanded: expandedBinding(for: row.node.id),
                depth: row.depth,
                count: row.node.count,
                active: row.node.id == activeId,
                pressed: { activeId = row.node.id }
            )
            .simultaneousGesture(
                LongPressGesture(minimumDuration: 0.35).onEnded { _ in
                    guard !contextMenuEntries.isEmpty else { return }
                    contextMenuNodeId = row.node.id
                    contextMenuOpen = true
                }
            )
        }
    }

    private func expandedBinding(for id: String) -> Binding<Bool> {
        Binding(
            get: { expandedIds.contains(id) },
            set: { isExpanded in
                expandedIds = Self.toggled(expandedIds, id: id, included: isExpanded)
            }
        )
    }

    private func contextMenuBinding(for id: String) -> Binding<Bool> {
        Binding(
            get: { contextMenuOpen && contextMenuNodeId == id },
            set: { isOpen in
                contextMenuOpen = isOpen
                contextMenuNodeId = isOpen ? id : nil
            }
        )
    }

    // MARK: - Pure logic (unit-testable without a live view)

    /// Depth-first flatten of a node tree into render rows — a node's
    /// children only appear when the node itself is in `expandedIds`.
    public static func flatten(_ nodes: [MuiSidebarNode], depth: Int, expandedIds: [String]) -> [MuiSidebarFlatRow] {
        var rows: [MuiSidebarFlatRow] = []
        for node in nodes {
            rows.append(MuiSidebarFlatRow(node: node, depth: depth))
            if let children = node.children, !children.isEmpty, expandedIds.contains(node.id) {
                rows.append(contentsOf: flatten(children, depth: depth + 1, expandedIds: expandedIds))
            }
        }
        return rows
    }

    /// The next `expandedIds` list after setting `id`'s expansion state to
    /// `included` — idempotent (toggling to the state it already has is a
    /// no-op) so repeated `.onChange` firings don't grow the list.
    public static func toggled(_ expandedIds: [String], id: String, included: Bool) -> [String] {
        let already = expandedIds.contains(id)
        if included == already { return expandedIds }
        return included ? expandedIds + [id] : expandedIds.filter { $0 != id }
    }
}

#Preview("MuiSidebar — Populated") {
    struct Demo: View {
        @State private var active: String? = "iceland"
        @State private var expanded = ["trips"]
        var body: some View {
            MuiSidebar(
                sections: [
                    MuiSidebarSection(id: "cloud", label: "MAPLE CLOUD", nodes: [
                        MuiSidebarNode(id: "trips", label: "2026 Trips", icon: "folder", children: [
                            MuiSidebarNode(id: "iceland", label: "Iceland", icon: "photo", count: 214),
                            MuiSidebarNode(id: "faroe", label: "Faroe Islands", icon: "photo", count: 88),
                        ]),
                    ]),
                    MuiSidebarSection(id: "local", label: "LOCAL", nodes: [
                        MuiSidebarNode(id: "desktop", label: "Desktop", icon: "externaldrive"),
                    ]),
                ],
                toolbarEntries: [.item(MuiToolbarActionItem(id: "add", icon: "plus", label: "Add source"))],
                contextMenuEntries: [MuiContextMenuItem(id: "rename", label: "Rename"), MuiContextMenuItem(id: "remove", label: "Remove", destructive: true)],
                activeId: $active,
                expandedIds: $expanded
            )
            .frame(width: 220, height: 300)
        }
    }
    return Demo()
}

#Preview("MuiSidebar — Loading / Empty") {
    VStack(spacing: 0) {
        MuiSidebar(sections: [], loading: true).frame(width: 220, height: 140)
        MuiDivider()
        MuiSidebar(sections: []).frame(width: 220, height: 140)
    }
}
