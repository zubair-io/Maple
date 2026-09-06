import CoreGraphics
import XCTest

@testable import MapleCore

final class WhiteBalancePickGeometryTests: XCTestCase {
  func testLetterboxZoomAndPanAddressThePaintedImage() throws {
    let point = try XCTUnwrap(
      WhiteBalancePickGeometry.imagePoint(
        at: CGPoint(x: 440, y: 160), viewport: CGSize(width: 1000, height: 800),
        displayFrame: CGSize(width: 1200, height: 600), pan: CGSize(width: 180, height: -90),
        nativeSize: CGSize(width: 6000, height: 3000), crop: .identity))
    XCTAssertEqual(point.x, 0.3, accuracy: 1e-9)
    XCTAssertEqual(point.y, 0.25, accuracy: 1e-9)
    XCTAssertNil(
      WhiteBalancePickGeometry.imagePoint(
        at: .zero, viewport: CGSize(width: 1000, height: 800),
        displayFrame: CGSize(width: 600, height: 300), pan: .zero,
        nativeSize: CGSize(width: 6000, height: 3000), crop: .identity))
  }

  func testCroppedPickUsesCanonicalNativePixelRounding() throws {
    let point = try XCTUnwrap(
      WhiteBalancePickGeometry.imagePoint(
        at: CGPoint(x: 0, y: 0), viewport: CGSize(width: 300, height: 200),
        displayFrame: CGSize(width: 300, height: 200), pan: .zero,
        nativeSize: CGSize(width: 1001, height: 801),
        crop: Crop(top: 0.1234, left: 0.2345, bottom: 0.8765, right: 0.7891, angle: 0)))
    XCTAssertEqual(point.x, 234.0 / 1001, accuracy: 1e-9)
    // The crop's y-up bottom is floored and upper edge ceiled by CGRect.integral.
    XCTAssertEqual(point.y, 98.0 / 801, accuracy: 1e-9)
  }

  func testStraightenIsInvertedInImagePixelsBeforeNormalizing() throws {
    // 90° here makes an independent exact geometric oracle: the displayed
    // right-of-centre point was above the centre of the uncropped image.
    let point = try XCTUnwrap(
      WhiteBalancePickGeometry.imagePoint(
        at: CGPoint(x: 300, y: 100), viewport: CGSize(width: 400, height: 200),
        displayFrame: CGSize(width: 400, height: 200), pan: .zero,
        nativeSize: CGSize(width: 1000, height: 500),
        crop: Crop(top: 0.2, left: 0.1, bottom: 0.6, right: 0.9, angle: 90)))
    XCTAssertEqual(point.x, 0.45, accuracy: 1e-9)
    XCTAssertEqual(point.y, 0.1, accuracy: 1e-9)
  }

  func testEmptyRotatedCornersAndNonfiniteCoordinatesAreRejected() {
    let size = CGSize(width: 1000, height: 500)
    for location in [CGPoint.zero, CGPoint(x: CGFloat.nan, y: 200)] {
      XCTAssertNil(
        WhiteBalancePickGeometry.imagePoint(
          at: location, viewport: size, displayFrame: size, pan: .zero,
          nativeSize: size,
          crop: Crop(top: 0, left: 0, bottom: 1, right: 1, angle: 30)))
    }
  }
}
