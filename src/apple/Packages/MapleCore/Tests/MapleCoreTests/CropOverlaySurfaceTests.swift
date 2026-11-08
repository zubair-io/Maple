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
    XCTAssertTrue(input().pixelSize == (600, 400))
    XCTAssertTrue(input(scale: 0).pixelSize == (300, 200))
    var empty = input()
    empty.viewport = .zero
    XCTAssertTrue(empty.pixelSize == (0, 0))
    XCTAssertNil(CropOverlayRasterPool().rasterize(empty))
    var huge = input()
    huge.viewport = CGSize(width: 9000, height: 100)
    XCTAssertTrue(huge.pixelSize == (0, 200))
  }

  func testRasterizeDrawsMaskFrameAndDots() throws {
    let image = try XCTUnwrap(CropOverlayRasterPool().rasterize(input()))
    XCTAssertEqual(image.width, 600)
    XCTAssertEqual(image.bytesPerRow % 64, 0)
    XCTAssertEqual(image.height, 400)
    let bytes = try XCTUnwrap(image.dataProvider?.data as Data?)
    let pixel = { (x: Int, y: Int) -> [UInt8] in
      let at = y * image.bytesPerRow + x * 4
      return Array(bytes[at..<at + 4])
    }
    // Outside the crop (y 0..80 at 2 px/pt): dimmed black.
    XCTAssertEqual(pixel(300, 20), [0, 0, 0, 140])
    // Inside, away from the grid lines: untouched.
    XCTAssertEqual(pixel(100, 100), [0, 0, 0, 0])
    // A corner dot centre (60, 80): opaque white.
    XCTAssertEqual(pixel(60, 80), [255, 255, 255, 255])
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
