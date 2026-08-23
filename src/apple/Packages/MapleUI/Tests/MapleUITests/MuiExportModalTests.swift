import XCTest
@testable import MapleUI

final class MuiExportModalTests: XCTestCase {
    func testClampedQualityClampsIntoOneToHundred() {
        XCTAssertEqual(MuiExportModal.clampedQuality(raw: "0", fallback: 50), 1)
        XCTAssertEqual(MuiExportModal.clampedQuality(raw: "150", fallback: 50), 100)
        XCTAssertEqual(MuiExportModal.clampedQuality(raw: "75", fallback: 50), 75)
    }

    func testClampedQualityFallsBackOnUnparsableInput() {
        XCTAssertEqual(MuiExportModal.clampedQuality(raw: "abc", fallback: 42), 42)
    }
}
