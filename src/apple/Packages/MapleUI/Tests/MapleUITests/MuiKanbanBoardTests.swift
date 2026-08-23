import XCTest
@testable import MapleUI

final class MuiKanbanBoardTests: XCTestCase {
    private let columns: [MuiKanbanColumn] = [
        MuiKanbanColumn(id: "todo", title: "To Cull", cards: [
            MuiKanbanCard(id: "1", title: "IMG_0042.dng"),
            MuiKanbanCard(id: "2", title: "IMG_0043.dng"),
        ]),
        MuiKanbanColumn(id: "picked", title: "Picked", cards: [
            MuiKanbanCard(id: "3", title: "IMG_0050.dng"),
        ]),
    ]

    func testMoveResultAppendsTheCardToTheEndOfTheTargetColumn() {
        let result = MuiKanbanBoard.moveResult(columns: columns, cardId: "1", fromColumnId: "todo", toColumnId: "picked")
        let picked = try! XCTUnwrap(result?.columns.first { $0.id == "picked" })
        XCTAssertEqual(picked.cards.map(\.id), ["3", "1"])
    }

    func testMoveResultRemovesTheCardFromTheSourceColumn() {
        let result = MuiKanbanBoard.moveResult(columns: columns, cardId: "1", fromColumnId: "todo", toColumnId: "picked")
        let source = try! XCTUnwrap(result?.columns.first { $0.id == "todo" })
        XCTAssertEqual(source.cards.map(\.id), ["2"])
    }

    func testMoveResultEventReportsTheOriginDestinationAndLandingIndex() {
        let result = MuiKanbanBoard.moveResult(columns: columns, cardId: "1", fromColumnId: "todo", toColumnId: "picked")
        let event = try! XCTUnwrap(result?.event)
        XCTAssertEqual(event, MuiKanbanMoveEvent(cardId: "1", fromColumnId: "todo", toColumnId: "picked", toIndex: 1))
    }

    func testMoveResultIsNilWhenTheSourceColumnDoesNotExist() {
        XCTAssertNil(MuiKanbanBoard.moveResult(columns: columns, cardId: "1", fromColumnId: "missing", toColumnId: "picked"))
    }

    func testMoveResultIsNilWhenTheCardIsNotInTheSourceColumn() {
        XCTAssertNil(MuiKanbanBoard.moveResult(columns: columns, cardId: "3", fromColumnId: "todo", toColumnId: "picked"))
    }

    func testMoveResultIsNilWhenTheTargetColumnDoesNotExist() {
        XCTAssertNil(MuiKanbanBoard.moveResult(columns: columns, cardId: "1", fromColumnId: "todo", toColumnId: "missing"))
    }

    func testMoveResultToAnEmptyTargetLandsAtIndexZero() {
        let empty: [MuiKanbanColumn] = columns + [MuiKanbanColumn(id: "final", title: "Final", cards: [])]
        let result = MuiKanbanBoard.moveResult(columns: empty, cardId: "1", fromColumnId: "todo", toColumnId: "final")
        XCTAssertEqual(result?.event.toIndex, 0)
    }
}
