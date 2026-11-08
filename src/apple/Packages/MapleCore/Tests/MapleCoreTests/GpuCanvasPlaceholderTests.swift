// GpuCanvasPlaceholderTests.swift — #5758.
//
// The GPU canvas draws the seed still as its placeholder until the photo's
// first rendered frame. The geometry is the zoom's (the layer is framed at
// the photo's rect, see `EditorSeedCanvasGeometryTests`), so what this pins is
// the still's decode and the one ordering rule: no placeholder may present
// after the live chain has started presenting into the layer. Plain data —
// no Metal device or layer is needed.

import CoreGraphics
import XCTest

@testable import MapleCore

final class GpuCanvasPlaceholderTests: XCTestCase {

  private func makeImage(
    width: Int, height: Int, space: CFString, rgb: (UInt8, UInt8, UInt8)
  ) throws -> CGImage {
    let colorSpace = try XCTUnwrap(CGColorSpace(name: space))
    let rowBytes = width * 4
    let texel: [UInt8] = [rgb.0, rgb.1, rgb.2, 255]
    let bytes = Array(repeating: texel, count: width * height).flatMap { $0 }
    let provider = try XCTUnwrap(CGDataProvider(data: Data(bytes) as CFData))
    return try XCTUnwrap(
      CGImage(
        width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
        bytesPerRow: rowBytes, space: colorSpace,
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent))
  }

  private func makePixels() throws -> GpuPlaceholderPixels {
    try XCTUnwrap(
      GpuPlaceholderPixels(
        image: makeImage(width: 6, height: 4, space: CGColorSpace.sRGB, rgb: (10, 20, 30))))
  }

  // MARK: - Decode

  func testSRGBStillKeepsItsBytesAndIsTaggedSRGB() throws {
    let image = try makeImage(width: 6, height: 4, space: CGColorSpace.sRGB, rgb: (200, 100, 50))
    let pixels = try XCTUnwrap(GpuPlaceholderPixels(image: image))
    XCTAssertEqual(pixels.width, 6)
    XCTAssertEqual(pixels.height, 4)
    XCTAssertEqual(pixels.colorSpace, 0)
    XCTAssertEqual(pixels.bytes.count, 6 * 4 * 4)
    XCTAssertEqual(Array(pixels.bytes[0..<3]), [200, 100, 50])
  }

  func testDisplayP3StillStaysInItsOwnPrimaries() throws {
    let image = try makeImage(
      width: 4, height: 4, space: CGColorSpace.displayP3, rgb: (255, 0, 0))
    let pixels = try XCTUnwrap(GpuPlaceholderPixels(image: image))
    XCTAssertEqual(pixels.colorSpace, 1)
    XCTAssertEqual(Array(pixels.bytes[0..<3]), [255, 0, 0])
  }

  /// Any other profile is converted by CoreGraphics, so the core only ever
  /// sees the two encodings it re-encodes exactly: a wide-gamut one to
  /// Display P3, so a P3 canvas keeps its colour, and the rest to sRGB.
  func testOtherProfilesAreConvertedToTheNearestCoreEncoding() throws {
    let adobe = try makeImage(
      width: 4, height: 4, space: CGColorSpace.adobeRGB1998, rgb: (128, 128, 128))
    XCTAssertEqual(try XCTUnwrap(GpuPlaceholderPixels(image: adobe)).colorSpace, 1)
    let rec709 = try makeImage(
      width: 4, height: 4, space: CGColorSpace.itur_709, rgb: (128, 128, 128))
    XCTAssertEqual(try XCTUnwrap(GpuPlaceholderPixels(image: rec709)).colorSpace, 0)
  }

  /// The layer scales the drawable to the photo's frame, so a still of
  /// another aspect would be stretched, not letterboxed.
  func testStillFitsOnlyAFrameOfItsOwnAspect() throws {
    let thumbnail = try XCTUnwrap(
      GpuPlaceholderPixels(
        image: makeImage(width: 512, height: 341, space: CGColorSpace.sRGB, rgb: (1, 1, 1))))
    XCTAssertTrue(thumbnail.fits(CGSize(width: 900, height: 600)), "rounded short edge")
    XCTAssertTrue(thumbnail.fits(.zero), "not laid out yet")
    XCTAssertFalse(thumbnail.fits(CGSize(width: 600, height: 600)))
    XCTAssertFalse(thumbnail.fits(CGSize(width: 600, height: 900)))
  }

  func testLargeStillIsScaledToTheLongEdgeCapKeepingItsAspect() throws {
    let image = try makeImage(
      width: 8192, height: 2048, space: CGColorSpace.sRGB, rgb: (1, 2, 3))
    let pixels = try XCTUnwrap(GpuPlaceholderPixels(image: image))
    XCTAssertEqual(pixels.width, GpuPlaceholderPixels.maxLongEdge)
    XCTAssertEqual(pixels.height, GpuPlaceholderPixels.maxLongEdge / 4)
    XCTAssertEqual(pixels.bytes.count, pixels.width * pixels.height * 4)
  }

  // MARK: - Ordering rule

  func testGateAcceptsStillsUntilTheChainPresents() throws {
    let pixels = try makePixels()
    var gate = GpuPlaceholderGate()
    XCTAssertTrue(gate.offer(pixels, viewportPx: CGSize(width: 800, height: 600)))
    XCTAssertEqual(gate.pending, pixels)
    XCTAssertEqual(gate.viewportPx, CGSize(width: 800, height: 600))

    gate.chainWillPresent()
    XCTAssertFalse(gate.accepts)
    XCTAssertNil(gate.pending, "the chain owns the layer; the still is dropped")
    XCTAssertFalse(
      gate.offer(pixels, viewportPx: .zero), "a late display preview must not cover a render")
  }

  /// A still that lands while an earlier layer belonged to the chain is
  /// kept, so the next layer (blank until the chain presents there) shows it.
  func testStillOfferedWhileTheChainOwnsTheLayerShowsInTheNextLayer() throws {
    let pixels = try makePixels()
    var gate = GpuPlaceholderGate()
    gate.chainWillPresent()
    XCTAssertFalse(gate.offer(pixels, viewportPx: .zero))
    XCTAssertTrue(gate.layerChanged())
    XCTAssertTrue(gate.accepts)
    XCTAssertEqual(gate.pending, pixels)
  }

  func testNewLayerShowsTheLatestStillUntilTheChainPresentsThere() throws {
    let thumbnail = try makePixels()
    let preview = try XCTUnwrap(
      GpuPlaceholderPixels(
        image: makeImage(width: 12, height: 8, space: CGColorSpace.sRGB, rgb: (9, 9, 9))))
    var gate = GpuPlaceholderGate()
    XCTAssertTrue(gate.offer(thumbnail, viewportPx: .zero))
    XCTAssertTrue(gate.offer(preview, viewportPx: .zero))
    XCTAssertTrue(gate.layerChanged(), "the new layer is blank; the latest still re-presents")
    XCTAssertEqual(gate.pending, preview)
  }

  func testNewLayerAfterTheChainPresentedAcceptsAgainButHasNothingPending() throws {
    var gate = GpuPlaceholderGate()
    XCTAssertTrue(gate.offer(try makePixels(), viewportPx: .zero))
    gate.chainWillPresent()
    XCTAssertFalse(gate.layerChanged())
    XCTAssertTrue(gate.accepts)
  }

  // MARK: - Driver

  @MainActor
  func testDriverRefusesAPlaceholderOnceTheChainPresented() async throws {
    let driver = GpuLiveDriver()
    XCTAssertTrue(driver.acceptsPlaceholder)
    driver.placeholderChainWillPresent()
    XCTAssertFalse(driver.acceptsPlaceholder)
    let shown = await driver.showPlaceholder(try makePixels(), viewportPx: .zero)
    XCTAssertFalse(shown)
  }

  /// Before the canvas registers its layer the still is kept, not shown; the
  /// layer's registration presents it.
  @MainActor
  func testDriverKeepsTheStillUntilALayerRegisters() async throws {
    let driver = GpuLiveDriver()
    let pixels = try makePixels()
    let shown = await driver.showPlaceholder(pixels, viewportPx: .zero)
    XCTAssertFalse(shown)
    XCTAssertEqual(driver.placeholderGate.pending, pixels)
  }
}
