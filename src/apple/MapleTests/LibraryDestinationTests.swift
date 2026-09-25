#if os(iOS)

  import MapleCore
  import XCTest

  @testable import Maple

  final class LibraryDestinationTests: XCTestCase {
    func testPreviewHeroIsVisibleForPreviewAlone() {
      let asset = AssetRef.preview(displayName: "IMG_0001.dng")

      XCTAssertTrue(LibraryDestination.presentsPreviewHero(in: [.preview(asset)]))
    }

    func testPreviewHeroIsHiddenWhileEditorIsPushed() {
      let asset = AssetRef.preview(displayName: "IMG_0001.dng")

      XCTAssertFalse(
        LibraryDestination.presentsPreviewHero(in: [.preview(asset), .edit(asset)]),
        "the Preview overlay must not cover or intercept the pushed editor")
    }

    func testPreviewHeroIsHiddenWhenNoPreviewIsOpen() {
      let asset = AssetRef.preview(displayName: "IMG_0001.dng")

      XCTAssertFalse(LibraryDestination.presentsPreviewHero(in: []))
      XCTAssertFalse(LibraryDestination.presentsPreviewHero(in: [.edit(asset)]))
    }

    func testPushedDestinationsExcludePreviewAndPreserveEditor() {
      let asset = AssetRef.preview(displayName: "IMG_0001.dng")

      XCTAssertEqual(
        LibraryDestination.pushedDestinations(in: [.preview(asset), .edit(asset)]),
        [.edit(asset)])
    }
  }

#endif
