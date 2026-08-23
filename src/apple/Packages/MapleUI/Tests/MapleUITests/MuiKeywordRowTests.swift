import XCTest
@testable import MapleUI

final class MuiKeywordRowTests: XCTestCase {
    func testAddResultTrimsWhitespace() {
        XCTAssertEqual(MuiKeywordRow.addResult(draft: "  aurora  "), "aurora")
    }

    func testAddResultRejectsBlankDraft() {
        XCTAssertNil(MuiKeywordRow.addResult(draft: "   "))
        XCTAssertNil(MuiKeywordRow.addResult(draft: ""))
    }

    func testAddResultKeepsAnAlreadyTrimmedWord() {
        XCTAssertEqual(MuiKeywordRow.addResult(draft: "wildlife"), "wildlife")
    }

    // "Removed" is a caller-owned callback (the underlying Chip Row already
    // emits the tapped chip's own id straight through) rather than a
    // second pure function to test — MuiChipRowTests already covers that
    // id-passthrough at the Chip Row layer.
}
