// MuiMoveToModal.swift — Maple UI Organisms · Modals (unified-component-
// catalog.md §4.4). Destination tree picker, built on Overlay Shell from
// Search Bar, Tree Row (repeated, indented per depth), and Button. The
// visible row set is a pure function of the flat node list: while
// searching, every name match shows flat; otherwise only nodes whose whole
// ancestor chain is expanded are shown — ported from the web reference's
// `visibleNodes`/`isVisible`.

import SwiftUI

public struct MuiMoveToTreeNode: Identifiable, Sendable {
    public let id: String
    public let parentId: String?
    public let name: String
    public let depth: Int
    public let hasChildren: Bool

    public init(id: String, parentId: String?, name: String, depth: Int, hasChildren: Bool) {
        self.id = id
        self.parentId = parentId
        self.name = name
        self.depth = depth
        self.hasChildren = hasChildren
    }
}

public struct MuiMoveToModal: View {
    public let isPresented: Bool
    public let contained: Bool
    public let nodes: [MuiMoveToTreeNode]
    @Binding public var selectedId: String?
    public let moveConfirmed: ((String) -> Void)?
    public let dismissed: (() -> Void)?

    @State private var searchQuery = ""
    @State private var expandedIds: Set<String> = []

    public init(
        isPresented: Bool,
        contained: Bool = false,
        nodes: [MuiMoveToTreeNode],
        selectedId: Binding<String?>,
        moveConfirmed: ((String) -> Void)? = nil,
        dismissed: (() -> Void)? = nil
    ) {
        self.isPresented = isPresented
        self.contained = contained
        self.nodes = nodes
        self._selectedId = selectedId
        self.moveConfirmed = moveConfirmed
        self.dismissed = dismissed
    }

    private var visibleNodes: [MuiMoveToTreeNode] {
        Self.visibleNodes(nodes: nodes, searchQuery: searchQuery, expandedIds: expandedIds)
    }

    public var body: some View {
        MuiOverlayShell(isPresented: isPresented, accessibilityLabel: "Move To", contained: contained) {
            MuiText("Move To", variant: .sheetTitle)
        } content: {
            VStack(alignment: .leading, spacing: MuiTokens.spacingSm) {
                MuiSearchBar(value: $searchQuery, placeholder: "Search folders…")
                VStack(spacing: 0) {
                    ForEach(visibleNodes) { node in
                        MuiTreeRow(
                            label: node.name, expandable: node.hasChildren,
                            expanded: Binding(get: { expandedIds.contains(node.id) }, set: { toggleExpand(node.id, expand: $0) }),
                            depth: node.depth, active: node.id == selectedId,
                            pressed: { selectedId = node.id }
                        )
                    }
                }
            }
        } footer: {
            HStack {
                Spacer()
                MuiButton(label: "Cancel", variant: .ghost) { dismissed?() }
                MuiButton(label: "Move", variant: .primary, disabled: selectedId == nil) { confirmMove() }
            }
        } dismissed: {
            dismissed?()
        }
    }

    private func toggleExpand(_ nodeId: String, expand: Bool) {
        if expand { expandedIds.insert(nodeId) } else { expandedIds.remove(nodeId) }
    }

    private func confirmMove() {
        guard let selectedId else { return }
        moveConfirmed?(selectedId)
    }

    // MARK: - Pure logic (unit-testable without a live view)

    public static func visibleNodes(nodes: [MuiMoveToTreeNode], searchQuery: String, expandedIds: Set<String>) -> [MuiMoveToTreeNode] {
        let query = searchQuery.trimmingCharacters(in: .whitespaces).lowercased()
        if !query.isEmpty {
            return nodes.filter { $0.name.lowercased().contains(query) }
        }
        return nodes.filter { isVisible($0, all: nodes, expanded: expandedIds) }
    }

    static func isVisible(_ node: MuiMoveToTreeNode, all: [MuiMoveToTreeNode], expanded: Set<String>) -> Bool {
        var current = node
        while let parentId = current.parentId {
            guard expanded.contains(parentId) else { return false }
            guard let parent = all.first(where: { $0.id == parentId }) else { return true }
            current = parent
        }
        return true
    }
}

#Preview("MuiMoveToModal") {
    struct Demo: View {
        @State private var open = false
        @State private var selected: String?
        var body: some View {
            ZStack {
                MuiTokens.bg
                MuiButton(label: "Open Move To", variant: .primary) { open = true }
                MuiMoveToModal(
                    isPresented: open,
                    nodes: [
                        MuiMoveToTreeNode(id: "trips", parentId: nil, name: "Trips", depth: 0, hasChildren: true),
                        MuiMoveToTreeNode(id: "iceland", parentId: "trips", name: "Iceland 2026", depth: 1, hasChildren: false),
                    ],
                    selectedId: $selected,
                    dismissed: { open = false }
                )
            }
            .frame(width: 380, height: 320)
        }
    }
    return Demo()
}
