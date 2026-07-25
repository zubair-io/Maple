// AdjustmentClipboardTests.swift — unit tests for AdjustmentClipboard (#944).

import XCTest
@testable import MapleCore

@MainActor
final class AdjustmentClipboardTests: XCTestCase {

    func testStartsEmpty() {
        let clipboard = AdjustmentClipboard()
        XCTAssertFalse(clipboard.hasContents)
        XCTAssertNil(clipboard.contents)
    }

    func testCopyPopulatesContents() {
        let clipboard = AdjustmentClipboard()
        var model = AdjustmentModel.default
        model.exposure = 1.5

        clipboard.copy(model: model, sourceName: "IMG_0012")

        XCTAssertTrue(clipboard.hasContents)
        XCTAssertEqual(clipboard.contents?.model.exposure, 1.5)
        XCTAssertEqual(clipboard.contents?.sourceName, "IMG_0012")
    }

    func testCopyReplacesPriorContents() {
        let clipboard = AdjustmentClipboard()
        clipboard.copy(model: .default, sourceName: "A")
        var second = AdjustmentModel.default
        second.contrast = 30
        clipboard.copy(model: second, sourceName: "B")

        XCTAssertEqual(clipboard.contents?.sourceName, "B")
        XCTAssertEqual(clipboard.contents?.model.contrast, 30)
    }

    func testClearEmptiesContents() {
        let clipboard = AdjustmentClipboard()
        clipboard.copy(model: .default, sourceName: "A")
        clipboard.clear()

        XCTAssertFalse(clipboard.hasContents)
        XCTAssertNil(clipboard.contents)
    }
}
