import XCTest
@testable import MapleUI

final class MuiPageNotificationsTests: XCTestCase {
    private let notifications: [MuiNotificationItem] = [
        MuiNotificationItem(id: "1", label: "A", category: "mentions", timestamp: Date()),
        MuiNotificationItem(id: "2", label: "B", category: "shares", timestamp: Date(), read: true),
    ]

    func testMarkingReadFlipsOnlyTheMatchingNotification() {
        let next = MuiPageNotifications.markingRead(notifications, id: "1")
        XCTAssertTrue(next[0].read)
        XCTAssertTrue(next[1].read)
        XCTAssertEqual(next.map(\.id), ["1", "2"])
    }

    func testMarkingReadOnAnAlreadyReadNotificationStaysRead() {
        let next = MuiPageNotifications.markingRead(notifications, id: "2")
        XCTAssertTrue(next[1].read)
    }

    func testMarkingReadWithAnUnknownIdChangesNothing() {
        let next = MuiPageNotifications.markingRead(notifications, id: "missing")
        XCTAssertFalse(next[0].read)
        XCTAssertTrue(next[1].read)
    }
}
