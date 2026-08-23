import XCTest
@testable import MapleUI

final class MuiDiagnosticsTests: XCTestCase {
    func testBadgeVariantIsSignalOnlyForFail() {
        XCTAssertEqual(MuiDiagnostics.badgeVariant(.fail), .signal)
        XCTAssertEqual(MuiDiagnostics.badgeVariant(.pass), .count)
        XCTAssertEqual(MuiDiagnostics.badgeVariant(.pending), .count)
    }

    func testStatusLabelText() {
        XCTAssertEqual(MuiDiagnostics.statusLabel(.pass), "Pass")
        XCTAssertEqual(MuiDiagnostics.statusLabel(.fail), "Fail")
        XCTAssertEqual(MuiDiagnostics.statusLabel(.pending), "Pending")
    }
}
