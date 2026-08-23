import XCTest
@testable import MapleUI

final class MuiChipRowTests: XCTestCase {
    func testNextSelectionSelectsTappedChip() {
        XCTAssertEqual(MuiChipRow.nextSelection(current: nil, tapped: "raw"), "raw")
    }

    func testNextSelectionReselectingTheCurrentChipIsANoOp() {
        XCTAssertEqual(MuiChipRow.nextSelection(current: "raw", tapped: "raw"), "raw")
    }

    func testNextSelectionSwitchesToTheNewlyTappedChip() {
        XCTAssertEqual(MuiChipRow.nextSelection(current: "raw", tapped: "jpeg"), "jpeg")
    }

    func testAddResultTrimsWhitespace() {
        XCTAssertEqual(MuiChipRow.addResult(draft: "  Wildlife  "), "Wildlife")
    }

    func testAddResultRejectsBlankDraft() {
        XCTAssertNil(MuiChipRow.addResult(draft: "   "))
        XCTAssertNil(MuiChipRow.addResult(draft: ""))
    }
}
