import XCTest
@testable import MapleUI

final class MuiPageChatTests: XCTestCase {
    func testAppendedChatMessagesAddsAnOwnMessageWithTheGivenText() {
        let sentAt = Date()
        let next = MuiPageChat.appendedChatMessages([], text: "Hello", sentAt: sentAt)
        XCTAssertEqual(next.count, 1)
        XCTAssertEqual(next[0].author, "You")
        XCTAssertEqual(next[0].text, "Hello")
        XCTAssertTrue(next[0].own)
        XCTAssertEqual(next[0].sentAt, sentAt)
    }

    func testAppendedChatMessagesPreservesExistingMessagesAndOrder() {
        let existing = [MuiChatMessageData(id: "1", author: "Ada", text: "Hi", sentAt: Date())]
        let next = MuiPageChat.appendedChatMessages(existing, text: "Reply")
        XCTAssertEqual(next.map(\.id), ["1", "2"])
    }

    func testAppendedThreadMessagesAddsAnOwnReply() {
        let next = MuiPageChat.appendedThreadMessages([], text: "On it")
        XCTAssertEqual(next.count, 1)
        XCTAssertEqual(next[0].text, "On it")
        XCTAssertTrue(next[0].own)
    }

    func testAppendedMessagesAssignNumericIdsThatDoNotCollideWithExistingOnes() {
        let existing = [MuiChatMessageData(id: "5", author: "Ada", text: "Hi", sentAt: Date())]
        let next = MuiPageChat.appendedChatMessages(existing, text: "Reply")
        XCTAssertEqual(next.last?.id, "6")
    }
}
