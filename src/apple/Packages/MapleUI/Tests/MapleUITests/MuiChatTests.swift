import XCTest
@testable import MapleUI

final class MuiChatTests: XCTestCase {
    // MARK: - Send

    func testTrimmedNonEmptySendsTrimmedText() {
        XCTAssertEqual(MuiChat.trimmedNonEmpty("  hello  "), "hello")
    }

    func testTrimmedNonEmptyRejectsBlankComposer() {
        XCTAssertNil(MuiChat.trimmedNonEmpty("   "))
        XCTAssertNil(MuiChat.trimmedNonEmpty(""))
    }

    // MARK: - Mention detection

    func testMentionQueryFindsTextAfterLastAt() {
        XCTAssertEqual(MuiChatMentionMath.mentionQuery(composerValue: "hey @ada"), "ada")
        XCTAssertEqual(MuiChatMentionMath.mentionQuery(composerValue: "cc @ada and @gra"), "gra")
    }

    func testMentionQueryIsNilWithoutAt() {
        XCTAssertNil(MuiChatMentionMath.mentionQuery(composerValue: "no mention here"))
    }

    func testMentionQueryClosesOnWhitespaceAfterAt() {
        XCTAssertNil(MuiChatMentionMath.mentionQuery(composerValue: "hey @ada is here"))
    }

    func testSuggestionsFiltersCaseInsensitively() {
        let users = [MuiMentionableUser(id: "1", name: "Ada Lovelace"), MuiMentionableUser(id: "2", name: "Grace Hopper")]
        let result = MuiChatMentionMath.suggestions(query: "ADA", users: users)
        XCTAssertEqual(result.map(\.id), ["1"])
    }

    func testSuggestionsEmptyWhenQueryNil() {
        let users = [MuiMentionableUser(id: "1", name: "Ada Lovelace")]
        XCTAssertTrue(MuiChatMentionMath.suggestions(query: nil, users: users).isEmpty)
    }

    func testApplyMentionReplacesTrailingTrigger() {
        let result = MuiChatMentionMath.applyMention(composerValue: "cc @ad", userName: "Ada Lovelace")
        XCTAssertEqual(result, "cc @Ada Lovelace ")
    }

    func testApplyMentionUnchangedWithoutAt() {
        XCTAssertEqual(MuiChatMentionMath.applyMention(composerValue: "no trigger", userName: "Ada"), "no trigger")
    }
}
