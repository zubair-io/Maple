import XCTest
@testable import MapleUI

final class MuiResultReportModalTests: XCTestCase {
    func testSummaryCountsEachStatus() {
        let results = [
            MuiResultItem(id: "1", label: "a", status: .success),
            MuiResultItem(id: "2", label: "b", status: .success),
            MuiResultItem(id: "3", label: "c", status: .error),
            MuiResultItem(id: "4", label: "d", status: .skipped),
        ]
        XCTAssertEqual(MuiResultReportModal.summary(results), "2 succeeded, 1 failed, 1 skipped")
    }

    func testSummaryAllZeroForEmptyResults() {
        XCTAssertEqual(MuiResultReportModal.summary([]), "0 succeeded, 0 failed, 0 skipped")
    }

    func testBadgeVariantIsSignalOnlyForError() {
        XCTAssertEqual(MuiResultReportModal.badgeVariant(.error), .signal)
        XCTAssertEqual(MuiResultReportModal.badgeVariant(.success), .count)
        XCTAssertEqual(MuiResultReportModal.badgeVariant(.skipped), .count)
    }

    func testStatusLabelText() {
        XCTAssertEqual(MuiResultReportModal.statusLabel(.success), "Success")
        XCTAssertEqual(MuiResultReportModal.statusLabel(.error), "Error")
        XCTAssertEqual(MuiResultReportModal.statusLabel(.skipped), "Skipped")
    }
}
