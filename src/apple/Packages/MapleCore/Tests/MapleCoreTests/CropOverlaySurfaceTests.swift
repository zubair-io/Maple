// CropOverlaySurfaceTests.swift — the Swift side of the shared crop overlay
// (#5715): handle centres for the accessible elements, surface sizing, and
// the CPU rasterizer the fallback layer shows.

import CoreGraphics
import XCTest

@testable import MapleCore

final class CropOverlaySurfaceTests: XCTestCase {
  private func input(
    crop: Crop = Crop(top: 0.2, left: 0.1, bottom: 0.8, right: 0.9, angle: 0),
    scale: Double = 2, active: CropGeometry.Handle? = nil
  ) -> CropOverlayInput {
    CropOverlayInput(
      crop: crop, viewport: CGSize(width: 300, height: 200),
      imageSize: CGSize(width: 600, height: 400), pixelScale: scale, activeHandle: active)
  }

  func testHandleCentersSitOnTheCropRect() {
    let fp = CropGeometry.fitFootprint(wrapW: 300, wrapH: 200, imgW: 600, imgH: 400)
    let rect = CropGeometry.cropRectToPx(input().crop, fp)
    let corner = CropOverlaySurface.handleCenter(.br, input())
    XCTAssertEqual(corner.x, rect.x + rect.width, accuracy: 1e-9)
    XCTAssertEqual(corner.y, rect.y + rect.height, accuracy: 1e-9)
    let left = CropOverlaySurface.handleCenter(.l, input())
    XCTAssertEqual(left.x, rect.x, accuracy: 1e-9)
    XCTAssertEqual(left.y, rect.y + rect.height / 2, accuracy: 1e-9)
    XCTAssertEqual(CropOverlaySurface.accessibleHandles.count, 8)
    XCTAssertFalse(CropOverlaySurface.accessibleHandles.contains(.move))
  }

  func testPixelSizeScalesAndRejectsDegenerateInput() {
    let margin = Int(CropOverlayInput.overscan * 2)
    XCTAssertTrue(input().pixelSize == (600 + 2 * margin, 400 + 2 * margin))
    XCTAssertTrue(input(scale: 0).pixelSize == (300 + margin, 200 + margin))
    var empty = input()
    empty.viewport = .zero
    XCTAssertTrue(empty.pixelSize == (0, 0))
    XCTAssertNil(CropOverlayRasterPool().rasterize(empty))
    var huge = input()
    huge.viewport = CGSize(width: 9000, height: 100)
    XCTAssertTrue(huge.pixelSize == (0, 200 + 2 * margin))
  }

  func testRasterizeDrawsMaskFrameAndDots() throws {
    let image = try XCTUnwrap(CropOverlayRasterPool().rasterize(input()))
    let margin = Int(CropOverlayInput.overscan * 2)
    XCTAssertEqual(image.width, 600 + 2 * margin)
    XCTAssertEqual(image.bytesPerRow % 64, 0)
    XCTAssertEqual(image.height, 400 + 2 * margin)
    let bytes = try XCTUnwrap(image.dataProvider?.data as Data?)
    let pixel = { (x: Int, y: Int) -> [UInt8] in
      let at = (y + margin) * image.bytesPerRow + (x + margin) * 4
      return Array(bytes[at..<at + 4])
    }
    // Outside the crop (y 0..80 viewport px at 2 px/pt): dimmed black.
    XCTAssertEqual(pixel(300, 20), [0, 0, 0, 140])
    // Inside, away from the grid lines: untouched.
    XCTAssertEqual(pixel(100, 100), [0, 0, 0, 0])
    // A corner dot centre (60, 80): opaque white.
    XCTAssertEqual(pixel(60, 80), [255, 255, 255, 255])
  }

  func testFullFrameFitKeepsEveryDotInsideTheDrawable() throws {
    let full = input(crop: Crop(top: 0, left: 0, bottom: 1, right: 1, angle: 0))
    let image = try XCTUnwrap(CropOverlayRasterPool().rasterize(full))
    let bytes = try XCTUnwrap(image.dataProvider?.data as Data?)
    let alpha = { (x: Int, y: Int) -> UInt8 in bytes[y * image.bytesPerRow + x * 4 + 3] }
    let (width, height) = (image.width, image.height)
    let border =
      (0..<width).flatMap { [($0, 0), ($0, height - 1)] }
      + (0..<height).flatMap { [(0, $0), (width - 1, $0)] }
    XCTAssertTrue(border.allSatisfy { alpha($0.0, $0.1) == 0 }, "nothing reaches the edge")
    let margin = Int(CropOverlayInput.overscan * 2)
    for handle in [CropGeometry.Handle.tl, .tr, .bl, .br] {
      let centre = CropOverlaySurface.handleCenter(handle, full)
      let x = Int(centre.x * 2) + margin
      let y = Int(centre.y * 2) + margin
      XCTAssertEqual(alpha(x, y), 255, "\(handle) dot drawn")
    }
  }

  func testActiveHandleChangesTheRaster() throws {
    let pool = CropOverlayRasterPool()
    let idle = try XCTUnwrap(pool.rasterize(input()))
    let dragged = try XCTUnwrap(pool.rasterize(input(active: .t)))
    XCTAssertNotEqual(idle.dataProvider?.data as Data?, dragged.dataProvider?.data as Data?)
  }

  func testReleasedImagesReturnTheirBufferToThePool() {
    let pool = CropOverlayRasterPool()
    autoreleasepool {
      let shown = (pool.rasterize(input()), pool.rasterize(input()))
      withExtendedLifetime(shown) {
        XCTAssertNotNil(shown.0)
        XCTAssertNotNil(shown.1)
        XCTAssertEqual(pool.pooledCount, 0, "a buffer under a live image is never reused")
      }
    }
    XCTAssertEqual(pool.pooledCount, 2)
    autoreleasepool { _ = pool.rasterize(input()) }
    XCTAssertEqual(pool.pooledCount, 2, "a stable size reuses a pooled buffer")
    autoreleasepool { _ = pool.rasterize(input(scale: 1)) }
    XCTAssertEqual(pool.pooledCount, 1, "a new size drops buffers of the old one")
  }

  func testGenerationsAreUnique() {
    let first = CropOverlaySurface.nextGeneration()
    XCTAssertGreaterThan(CropOverlaySurface.nextGeneration(), first)
  }
}
