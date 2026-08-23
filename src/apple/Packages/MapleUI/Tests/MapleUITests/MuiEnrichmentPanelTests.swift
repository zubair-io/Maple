import XCTest
@testable import MapleUI

final class MuiEnrichmentPanelTests: XCTestCase {
    func testStatusLabelIsNilWhileIdle() {
        XCTAssertNil(MuiEnrichmentPanel.statusLabel(.idle))
    }

    func testStatusLabelWhileGenerating() {
        XCTAssertEqual(MuiEnrichmentPanel.statusLabel(.generating), "Generating…")
    }

    func testStatusLabelWhenDone() {
        XCTAssertEqual(MuiEnrichmentPanel.statusLabel(.done), "Done")
    }

    func testStatusLabelOnError() {
        XCTAssertEqual(MuiEnrichmentPanel.statusLabel(.error), "Error")
    }
}
