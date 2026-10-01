import CoreGraphics
import XCTest

@testable import MapleCore

final class MaskHandleGeometryTests: XCTestCase {
  func testCropZoomPanStraightenPlacementInvertsExactly() throws {
    let full = try XCTUnwrap(
      MaskOverlayGeometry.fullFrameRect(
        containerSize: CGSize(width: 800, height: 600),
        displayFrame: CGSize(width: 1200, height: 900), panOffset: CGSize(width: 110, height: -70),
        crop: Crop(top: 0.1, left: 0.2, bottom: 0.9, right: 0.8, angle: 17)))
    for p in [MaskPoint(x: 0.3, y: 0.25), MaskPoint(x: 0.5, y: 0.75)] {
      let screen = MaskHandleGeometry.screenPoint(p, fullFrame: full, angleDegrees: 17)
      let back = MaskHandleGeometry.normalizedPoint(screen, fullFrame: full, angleDegrees: 17)
      XCTAssertEqual(back.x, p.x, accuracy: 1e-12)
      XCTAssertEqual(back.y, p.y, accuracy: 1e-12)
    }
  }

  func testLinearBodyStopsAtFrameEdgeWithoutChangingSpanOrFeather() {
    let mask = LocalMask.linear(
      start: MaskPoint(x: 0.1, y: 0.2), end: MaskPoint(x: 0.8, y: 0.7), feather: 0.35)
    let moved = MaskHandleGeometry.drag(
      mask, handle: .linearBody,
      to: MaskPoint(x: 1, y: 0), anchor: MaskPoint(x: 0.45, y: 0.45))
    guard case .linear(let start, let end, let feather) = moved else { return XCTFail() }
    XCTAssertEqual(start.x, 0.3, accuracy: 1e-12)
    XCTAssertEqual(end.x, 1, accuracy: 1e-12)
    XCTAssertEqual(start.y, 0, accuracy: 1e-12)
    XCTAssertEqual(end.y, 0.5, accuracy: 1e-12)
    XCTAssertEqual(feather, 0.35)
    XCTAssertEqual(MaskHandleGeometry.handles(mask).count, 3)
  }

  func testRotatedRadialHandlesChangeOnlySelectedParameter() throws {
    let center = MaskPoint(x: 0.5, y: 0.5)
    let mask = LocalMask.radial(
      center: center, radii: MaskPoint(x: 0.2, y: 0.3), angle: .pi / 2, feather: 0.4, invert: true)
    let x = try XCTUnwrap(
      MaskHandleGeometry.handles(mask).first(where: { $0.handle == .radialRadiusX }))
    XCTAssertEqual(x.point.x, 0.5, accuracy: 1e-12)
    XCTAssertEqual(x.point.y, 0.7, accuracy: 1e-12)
    let resized = MaskHandleGeometry.drag(
      mask, handle: .radialRadiusX, to: MaskPoint(x: 0.5, y: 0.9), anchor: x.point)
    guard case .radial(let c, let radii, let a, let f, let inverted) = resized else {
      return XCTFail()
    }
    XCTAssertEqual(c, center)
    XCTAssertEqual(radii.x, 0.4, accuracy: 1e-12)
    XCTAssertEqual(radii.y, 0.3)
    XCTAssertEqual(a, .pi / 2)
    XCTAssertEqual(f, 0.4)
    XCTAssertTrue(inverted)
    let collapsed = MaskHandleGeometry.drag(
      mask, handle: .radialRadiusY, to: center, anchor: center)
    guard case .radial(_, let tiny, _, _, _) = collapsed else { return XCTFail() }
    XCTAssertEqual(tiny.y, 0.01)
    XCTAssertEqual(MaskHandleGeometry.outline(mask).count, 73)
  }
}
