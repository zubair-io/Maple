// ThumbnailCameraPreviewReuseTests.swift — a cold RAW tile extracts its camera JPEG
// once: the AVIF grid and preview tiers reuse the seed the cell already fetched.

import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest

@testable import MapleCore

final class ThumbnailCameraPreviewReuseTests: XCTestCase {

  private var folder: URL!

  override func setUpWithError() throws {
    folder = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-camera-reuse-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: folder)
  }

  func testAVIFTierEncodesTheSeededCameraJPEG() throws {
    let raw = try unreadableRaw()
    ThumbnailLoader.cameraPreviewCache.setObject(
      try jpeg() as NSData, forKey: ThumbnailDiskCache.memoryKey(for: raw) as NSString)

    let avif = ThumbnailLoader.embeddedCameraAVIF(at: raw, targetLongEdge: 32, quality: 0.5)

    XCTAssertNotNil(avif)
  }

  func testAVIFTierIgnoresASeedFromBeforeTheFileChanged() throws {
    let raw = try unreadableRaw()
    ThumbnailLoader.cameraPreviewCache.setObject(
      try jpeg() as NSData, forKey: ThumbnailDiskCache.memoryKey(for: raw) as NSString)
    try FileManager.default.setAttributes(
      [.modificationDate: Date(timeIntervalSinceNow: -3600)], ofItemAtPath: raw.path)

    let avif = ThumbnailLoader.embeddedCameraAVIF(at: raw, targetLongEdge: 32, quality: 0.5)

    XCTAssertNil(avif)
  }

  private func unreadableRaw() throws -> URL {
    let raw = folder.appendingPathComponent("frame.dng")
    try Data("not a raw container".utf8).write(to: raw)
    return raw
  }

  private func jpeg() throws -> Data {
    let width = 64
    let height = 48
    let context = try XCTUnwrap(
      CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
    context.setFillColor(red: 0.8, green: 0.4, blue: 0.2, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let image = try XCTUnwrap(context.makeImage())
    let output = NSMutableData()
    let destination = try XCTUnwrap(
      CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, nil)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    return output as Data
  }
}
