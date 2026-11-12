import XCTest

@testable import MapleCore

/// #5050 review: the move/copy ask-flow asks about each file of a stacked tile by that file's
/// name, and an answer for the RAW never becomes the JPEG's.
final class RawJpegStackCollisionAskTests: XCTestCase {
  private let stack = RawJpegStack(
    primary: .init(name: "IMG_1.CR3", size: nil), companion: .init(name: "IMG_1.JPG", size: nil),
    location: .local(URL(fileURLWithPath: "/a/IMG_1.JPG")))

  func testReplaceOnTheRawLeavesTheJpegToItsOwnPrompt() {
    var ask = StackCollisionAsk(stack: stack)

    XCTAssertEqual(ask.promptName(for: "/b/IMG_1.CR3", tileName: "IMG_1.CR3"), "IMG_1.CR3")
    XCTAssertTrue(ask.answer(.replace, for: "/b/IMG_1.CR3"))
    XCTAssertEqual(ask.primary, .replace)
    XCTAssertEqual(ask.companion, .fail)

    XCTAssertEqual(ask.promptName(for: "/b/IMG_1.JPG", tileName: "IMG_1.CR3"), "IMG_1.JPG")
    XCTAssertTrue(ask.answer(.replace, for: "/b/IMG_1.JPG"))
    XCTAssertEqual(ask.companion, .replace)
    XCTAssertNil(
      ask.promptName(for: "/b/IMG_1.JPG", tileName: "IMG_1.CR3"), "a second collision fails")
  }

  func testKeepBothMovesThePairAndIsNeverAskedTwice() {
    var ask = StackCollisionAsk(stack: stack)

    XCTAssertTrue(ask.answer(.keepBoth, for: "/b/img_1.jpg"))

    XCTAssertEqual(ask.primary, .autoSuffix)
    XCTAssertEqual(ask.companion, .fail)
    XCTAssertNil(ask.promptName(for: "/b/IMG_1.1.CR3", tileName: "IMG_1.CR3"))
  }

  func testSkipSkipsTheTile() {
    var ask = StackCollisionAsk(stack: stack)
    XCTAssertFalse(ask.answer(.skip, for: "/b/IMG_1.JPG"))
  }

  func testATileWithoutAStackAsksOnlyAboutItself() {
    var ask = StackCollisionAsk(stack: nil)

    XCTAssertFalse(ask.namesCompanion("/b/photo.jpg"))
    XCTAssertEqual(ask.promptName(for: "/b/photo.jpg", tileName: "photo.jpg"), "photo.jpg")
    XCTAssertTrue(ask.answer(.replace, for: "/b/photo.jpg"))
    XCTAssertEqual(ask.primary, .replace)
    XCTAssertNil(ask.promptName(for: "/b/photo.jpg", tileName: "photo.jpg"))
  }
}
