import XCTest
@testable import MapleUI

final class MuiBatchMetadataModalTests: XCTestCase {
    func testConfirmMessageDescribesPendingChanges() {
        let message = MuiBatchMetadataModal.confirmMessage(keywordCount: 3, itemCount: 12)
        XCTAssertEqual(message, "Apply copyright, 3 keyword(s), and rating to 12 item(s)?")
    }

    func testConfirmMessageWithNoKeywords() {
        XCTAssertEqual(MuiBatchMetadataModal.confirmMessage(keywordCount: 0, itemCount: 1), "Apply copyright, 0 keyword(s), and rating to 1 item(s)?")
    }
}
