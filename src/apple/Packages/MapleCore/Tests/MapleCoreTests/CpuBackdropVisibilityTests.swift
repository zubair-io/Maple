import XCTest

@testable import MapleCore

final class CpuBackdropVisibilityTests: XCTestCase {
  private func shows(
    decoding: Bool = false, presented: Bool = false, thumbnailSeed: Bool, placeholder: Bool
  ) -> Bool {
    EditSession.showsCpuBackdrop(
      isFullQualityDecoding: decoding, gpuFramePresented: presented,
      backdropIsThumbnailSeed: thumbnailSeed, placeholderOnScreen: placeholder)
  }

  func test_thumbnailSeedStaysUnderAPlaceholderOnScreen() {
    XCTAssertFalse(shows(thumbnailSeed: true, placeholder: true))
    XCTAssertFalse(shows(decoding: true, thumbnailSeed: true, placeholder: true))
  }

  func test_thumbnailSeedShowsUntilThePlaceholderIsOnScreen() {
    XCTAssertTrue(shows(thumbnailSeed: true, placeholder: false))
  }

  func test_richerBackdropStillCoversThePlaceholder() {
    XCTAssertTrue(shows(thumbnailSeed: false, placeholder: true))
    XCTAssertTrue(shows(decoding: true, presented: true, thumbnailSeed: false, placeholder: true))
  }

  func test_noBackdropOnceTheCanvasHasPresented() {
    XCTAssertFalse(shows(presented: true, thumbnailSeed: false, placeholder: false))
  }
}
