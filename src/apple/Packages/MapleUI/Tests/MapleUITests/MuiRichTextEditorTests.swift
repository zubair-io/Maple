import XCTest
@testable import MapleUI

final class MuiRichTextEditorTests: XCTestCase {
    func testSlashCommandActiveWhenTextEndsWithSlash() {
        XCTAssertTrue(MuiRichTextEditorMath.slashCommandActive(text: "Notes/"))
        XCTAssertFalse(MuiRichTextEditorMath.slashCommandActive(text: "Notes/x"))
        XCTAssertFalse(MuiRichTextEditorMath.slashCommandActive(text: "Notes"))
    }

    func testApplyCommandInsertsHeadingPrefixAndRemovesSlash() {
        XCTAssertEqual(MuiRichTextEditorMath.applyCommand(text: "Notes/", commandId: "heading"), "Notes# ")
    }

    func testApplyCommandInsertsCodeFence() {
        XCTAssertEqual(MuiRichTextEditorMath.applyCommand(text: "/", commandId: "code"), "```\n\n```")
    }

    func testApplyCommandNilWhenNoTrailingSlash() {
        XCTAssertNil(MuiRichTextEditorMath.applyCommand(text: "no trigger", commandId: "heading"))
    }

    func testApplyCommandNilForUnknownCommand() {
        XCTAssertNil(MuiRichTextEditorMath.applyCommand(text: "text/", commandId: "unknown"))
    }

    func testWrapLastTokenWrapsTrailingWord() {
        XCTAssertEqual(MuiRichTextEditorMath.wrapLastToken(text: "a lone hiker", marker: "**"), "a lone **hiker**")
    }

    func testWrapLastTokenOnSingleWordWrapsWholeText() {
        XCTAssertEqual(MuiRichTextEditorMath.wrapLastToken(text: "hiker", marker: "*"), "*hiker*")
    }

    func testWrapLastTokenNoOpOnTrailingWhitespace() {
        XCTAssertEqual(MuiRichTextEditorMath.wrapLastToken(text: "hiker ", marker: "*"), "hiker ")
    }

    func testExtractCodeBlocksFindsFencedContent() {
        let blocks = MuiRichTextEditor.extractCodeBlocks(from: "before ```let x = 1``` after ```let y = 2```")
        XCTAssertEqual(blocks, ["let x = 1", "let y = 2"])
    }

    func testExtractCodeBlocksEmptyWithoutFences() {
        XCTAssertTrue(MuiRichTextEditor.extractCodeBlocks(from: "plain text").isEmpty)
    }
}
