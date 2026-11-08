import MapleCore
import XCTest

@testable import Maple

/// #5710: which screens draw the editor and Preview photo edge to edge.
final class FullBleedCanvasTests: XCTestCase {
  func testOpenDuoIsFullBleedInBothOrientations() {
    for screen in [CGSize(width: 669, height: 951), CGSize(width: 951, height: 669)] {
      XCTAssertTrue(FullBleedCanvas.isAllowed(idiom: .phone, screen: screen), "\(screen)")
    }
  }

  func testConventionalLandscapeIPhoneKeepsItsInset() {
    for screen in [
      CGSize(width: 932, height: 430), CGSize(width: 874, height: 402),
      CGSize(width: 667, height: 375),
    ] {
      XCTAssertFalse(FullBleedCanvas.isAllowed(idiom: .phone, screen: screen), "\(screen)")
    }
  }

  func testPortraitIPhoneIsFullBleed() {
    XCTAssertTrue(FullBleedCanvas.isAllowed(idiom: .phone, screen: CGSize(width: 402, height: 874)))
  }

  func testIPadAndMacAreFullBleedAtAnyShape() {
    for idiom: MapleDeviceIdiom in [.pad, .mac] {
      XCTAssertTrue(FullBleedCanvas.isAllowed(idiom: idiom, screen: CGSize(width: 2000, height: 400)))
    }
  }

  func testAnUnmeasuredScreenDoesNotDisableFullBleed() {
    XCTAssertTrue(FullBleedCanvas.isAllowed(idiom: .phone, screen: .zero))
  }
}
