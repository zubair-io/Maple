import XCTest
@testable import MapleUI

final class MuiNotificationFeedTests: XCTestCase {
    private let notifications = [
        MuiNotificationItem(id: "1", label: "Ada mentioned you", category: "mentions", timestamp: Date()),
        MuiNotificationItem(id: "2", label: "Grace shared an album", category: "shares", timestamp: Date()),
    ]

    func testFilteredAllReturnsEverything() {
        let result = MuiNotificationFeed.filtered(notifications, byFilterId: MuiNotificationFeed.allFilterId)
        XCTAssertEqual(result.count, 2)
    }

    func testFilteredByCategoryMatchesExactly() {
        let result = MuiNotificationFeed.filtered(notifications, byFilterId: "mentions")
        XCTAssertEqual(result.map(\.id), ["1"])
    }

    func testFilteredByUnknownCategoryIsEmpty() {
        XCTAssertTrue(MuiNotificationFeed.filtered(notifications, byFilterId: "nonexistent").isEmpty)
    }
}
