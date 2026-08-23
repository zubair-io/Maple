import XCTest
@testable import MapleUI

final class MuiResponseViewerTests: XCTestCase {
    func testStatusLabelCombinesCodeAndReasonPhrase() {
        XCTAssertEqual(MuiResponseViewer.statusLabel(status: 200, statusText: "OK"), "200 OK")
    }

    func testStatusLabelTrimsATrailingSpaceWhenReasonPhraseIsEmpty() {
        XCTAssertEqual(MuiResponseViewer.statusLabel(status: 204, statusText: ""), "204")
    }

    func testStatusVariantIsSignalForSuccess() {
        XCTAssertEqual(MuiResponseViewer.statusVariant(status: 200), .signal)
        XCTAssertEqual(MuiResponseViewer.statusVariant(status: 399), .signal)
    }

    func testStatusVariantIsCountForClientAndServerErrors() {
        XCTAssertEqual(MuiResponseViewer.statusVariant(status: 400), .count)
        XCTAssertEqual(MuiResponseViewer.statusVariant(status: 500), .count)
    }

    func testActiveContentSwitchesBetweenBodyAndHeaders() {
        XCTAssertEqual(MuiResponseViewer.activeContent(activeId: "body", body: "{}", headers: "x: 1"), "{}")
        XCTAssertEqual(MuiResponseViewer.activeContent(activeId: "headers", body: "{}", headers: "x: 1"), "x: 1")
    }
}
