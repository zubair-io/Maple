import XCTest
@testable import MapleUI

final class MuiSidebarTests: XCTestCase {
    private let nodes: [MuiSidebarNode] = [
        MuiSidebarNode(id: "trips", label: "2026 Trips", children: [
            MuiSidebarNode(id: "iceland", label: "Iceland", count: 214),
            MuiSidebarNode(id: "faroe", label: "Faroe Islands", count: 88),
        ]),
        MuiSidebarNode(id: "archive", label: "Archive"),
    ]

    func testFlattenWithNothingExpandedShowsOnlyTopLevelRows() {
        let rows = MuiSidebar.flatten(nodes, depth: 0, expandedIds: [])
        XCTAssertEqual(rows.map(\.id), ["trips", "archive"])
        XCTAssertEqual(rows.map(\.depth), [0, 0])
    }

    func testFlattenWithABranchExpandedInsertsItsChildrenRightAfterIt() {
        let rows = MuiSidebar.flatten(nodes, depth: 0, expandedIds: ["trips"])
        XCTAssertEqual(rows.map(\.id), ["trips", "iceland", "faroe", "archive"])
        XCTAssertEqual(rows.map(\.depth), [0, 1, 1, 0])
    }

    func testFlattenDoesNotExpandALeafNodeEvenIfItsIdIsInExpandedIds() {
        // "archive" has no children — being listed as "expanded" must not
        // conjure rows out of nothing.
        let rows = MuiSidebar.flatten(nodes, depth: 0, expandedIds: ["archive"])
        XCTAssertEqual(rows.map(\.id), ["trips", "archive"])
    }

    func testToggledAddsAnIdThatIsNotYetPresent() {
        XCTAssertEqual(MuiSidebar.toggled(["a"], id: "b", included: true), ["a", "b"])
    }

    func testToggledRemovesAnIdThatIsPresent() {
        XCTAssertEqual(MuiSidebar.toggled(["a", "b"], id: "a", included: false), ["b"])
    }

    func testToggledIsANoOpWhenTheRequestedStateAlreadyHolds() {
        XCTAssertEqual(MuiSidebar.toggled(["a"], id: "a", included: true), ["a"])
        XCTAssertEqual(MuiSidebar.toggled(["a"], id: "b", included: false), ["a"])
    }
}
