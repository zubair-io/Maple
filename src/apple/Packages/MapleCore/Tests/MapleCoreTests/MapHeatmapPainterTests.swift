// MapHeatmapPainterTests.swift
//
// The allocation-free heat-gradient drawing core (#2831). `radius(forWeight:)`
// is checked as pure math; `draw` is checked with an actual off-screen
// bitmap `CGContext` and a pixel readback — an objective signal (alpha at a
// known point), not an eyeballed screenshot, matching the repo's "no visual
// judgments" testing bar for anything that draws pixels.

import XCTest
import CoreGraphics
@testable import MapleCloudKit

final class MapHeatmapPainterTests: XCTestCase {

  // MARK: - radius(forWeight:)

  func test_radius_weightZero_isMinRadius() {
    XCTAssertEqual(MapHeatmapPainter.radius(forWeight: 0, minRadius: 10, maxRadius: 100), 10)
  }

  func test_radius_weightOne_isMaxRadius() {
    XCTAssertEqual(MapHeatmapPainter.radius(forWeight: 1, minRadius: 10, maxRadius: 100), 100)
  }

  func test_radius_weightHalf_isMidpoint() {
    XCTAssertEqual(MapHeatmapPainter.radius(forWeight: 0.5, minRadius: 10, maxRadius: 100), 55)
  }

  func test_radius_clampsNegativeWeightToMin() {
    XCTAssertEqual(MapHeatmapPainter.radius(forWeight: -3, minRadius: 10, maxRadius: 100), 10)
  }

  func test_radius_clampsOverOneWeightToMax() {
    XCTAssertEqual(MapHeatmapPainter.radius(forWeight: 7, minRadius: 10, maxRadius: 100), 100)
  }

  func test_radius_defaultsMatchPublishedScreenRadiusRange() {
    XCTAssertEqual(MapHeatmapPainter.radius(forWeight: 0), MapHeatmapPainter.minScreenRadius)
    XCTAssertEqual(MapHeatmapPainter.radius(forWeight: 1), MapHeatmapPainter.maxScreenRadius)
  }

  // MARK: - draw(blobs:opacity:in:)

  private func makeBitmapContext(width: Int = 200, height: Int = 200) -> CGContext {
    guard let context = CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
      fatalError("failed to create test bitmap context")
    }
    return context
  }

  /// Alpha channel (last byte of a `premultipliedLast` RGBA pixel) at
  /// `(x, y)` — an objective readback of what actually got drawn, not an
  /// eyeballed screenshot.
  private func alpha(atX x: Int, y: Int, in context: CGContext) -> UInt8 {
    guard let base = context.data else { return 0 }
    let bytesPerPixel = 4
    let offset = y * context.bytesPerRow + x * bytesPerPixel
    return base.assumingMemoryBound(to: UInt8.self)[offset + 3]
  }

  func test_draw_zeroOpacity_paintsNothing() {
    let context = makeBitmapContext()
    let blobs = [MapHeatmapBlob(center: CGPoint(x: 100, y: 100), radius: 50, weight: 1)]
    MapHeatmapPainter.draw(blobs: blobs, opacity: 0, in: context)
    XCTAssertEqual(alpha(atX: 100, y: 100, in: context), 0)
  }

  func test_draw_emptyBlobs_paintsNothing() {
    let context = makeBitmapContext()
    MapHeatmapPainter.draw(blobs: [], opacity: 1, in: context)
    XCTAssertEqual(alpha(atX: 100, y: 100, in: context), 0)
  }

  func test_draw_positiveOpacity_paintsBlobCenter() {
    let context = makeBitmapContext()
    let blobs = [MapHeatmapBlob(center: CGPoint(x: 100, y: 100), radius: 50, weight: 1)]
    MapHeatmapPainter.draw(blobs: blobs, opacity: 1, in: context)
    XCTAssertGreaterThan(alpha(atX: 100, y: 100, in: context), 0)
  }

  /// The gradient fades to fully transparent at `location: 1.0` (the
  /// blob's outer edge) — well outside `radius`, nothing should be drawn.
  func test_draw_farOutsideBlobRadius_leavesPixelUntouched() {
    let context = makeBitmapContext()
    let blobs = [MapHeatmapBlob(center: CGPoint(x: 20, y: 20), radius: 10, weight: 1)]
    MapHeatmapPainter.draw(blobs: blobs, opacity: 1, in: context)
    XCTAssertEqual(alpha(atX: 180, y: 180, in: context), 0)
  }

  func test_draw_zeroRadiusBlob_isSkipped() {
    let context = makeBitmapContext()
    let blobs = [MapHeatmapBlob(center: CGPoint(x: 100, y: 100), radius: 0, weight: 1)]
    MapHeatmapPainter.draw(blobs: blobs, opacity: 1, in: context)
    XCTAssertEqual(alpha(atX: 100, y: 100, in: context), 0)
  }

  /// `draw` takes a `Sequence` so callers can skip materializing an array
  /// per draw — a `lazy` chain must paint identically to an eager one.
  func test_draw_lazySequenceInput_paintsIdenticallyToArray() {
    let eager = makeBitmapContext()
    let lazily = makeBitmapContext()
    let weights = [1.0, 0.5]
    let blob = { (w: Double) in MapHeatmapBlob(center: CGPoint(x: 100, y: 100), radius: 40, weight: w) }

    MapHeatmapPainter.draw(blobs: weights.map(blob), opacity: 1, in: eager)
    MapHeatmapPainter.draw(blobs: weights.lazy.map(blob), opacity: 1, in: lazily)

    XCTAssertGreaterThan(alpha(atX: 100, y: 100, in: eager), 0)
    XCTAssertEqual(alpha(atX: 100, y: 100, in: eager), alpha(atX: 100, y: 100, in: lazily))
  }
}
