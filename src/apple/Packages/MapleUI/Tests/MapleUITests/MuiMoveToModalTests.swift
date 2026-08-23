import XCTest
@testable import MapleUI

final class MuiMoveToModalTests: XCTestCase {
    private let nodes = [
        MuiMoveToTreeNode(id: "trips", parentId: nil, name: "Trips", depth: 0, hasChildren: true),
        MuiMoveToTreeNode(id: "iceland", parentId: "trips", name: "Iceland 2026", depth: 1, hasChildren: true),
        MuiMoveToTreeNode(id: "glacier", parentId: "iceland", name: "Glacier hike", depth: 2, hasChildren: false),
        MuiMoveToTreeNode(id: "archived", parentId: nil, name: "Archived", depth: 0, hasChildren: false),
    ]

    func testVisibleNodesShowsOnlyRootsWhenNothingExpanded() {
        let visible = MuiMoveToModal.visibleNodes(nodes: nodes, searchQuery: "", expandedIds: [])
        XCTAssertEqual(Set(visible.map(\.id)), ["trips", "archived"])
    }

    func testVisibleNodesRevealsChildrenOfExpandedAncestors() {
        let visible = MuiMoveToModal.visibleNodes(nodes: nodes, searchQuery: "", expandedIds: ["trips"])
        XCTAssertEqual(Set(visible.map(\.id)), ["trips", "archived", "iceland"])
    }

    func testVisibleNodesRequiresWholeAncestorChainExpanded() {
        // "iceland" expanded but its parent "trips" isn't — "glacier" stays hidden.
        let visible = MuiMoveToModal.visibleNodes(nodes: nodes, searchQuery: "", expandedIds: ["iceland"])
        XCTAssertFalse(visible.map(\.id).contains("glacier"))
    }

    func testVisibleNodesShowsFullyExpandedDescendant() {
        let visible = MuiMoveToModal.visibleNodes(nodes: nodes, searchQuery: "", expandedIds: ["trips", "iceland"])
        XCTAssertTrue(visible.map(\.id).contains("glacier"))
    }

    func testVisibleNodesWhileSearchingIgnoresExpansionAndMatchesFlat() {
        let visible = MuiMoveToModal.visibleNodes(nodes: nodes, searchQuery: "glacier", expandedIds: [])
        XCTAssertEqual(visible.map(\.id), ["glacier"])
    }
}
