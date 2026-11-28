// ThumbnailCacheDecodeProofTests.swift — #6010: a warm thumbnail is decoded to
// prove it is usable once per cached read, not on every grid load, and a
// replaced or undecodable entry never inherits that proof.

import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest

@testable import MapleCore

final class ThumbnailCacheDecodeProofTests: XCTestCase {

  private var folder: URL!

  override func setUp() async throws {
    folder = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-thumb-proof-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
  }

  override func tearDown() async throws {
    try? FileManager.default.removeItem(at: folder)
  }

  func testDiskHitIsUnprovenUntilMarkedThenStaysProven() async throws {
    let asset = try writeAsset(named: "proof.png")
    let jpeg = try Self.jpegBytes(width: 64, height: 48)
    try writeFreshDerivative(jpeg, for: asset)
    let cache = ThumbnailDiskCache.shared

    let firstHit = await cache.cachedThumbnail(for: asset)
    let first = try XCTUnwrap(firstHit)
    XCTAssertEqual(first.data, jpeg)
    XCTAssertFalse(first.isKnownDecodable, "bytes read from disk carry no decode proof")

    await cache.markDecodable(first)
    let secondHit = await cache.cachedThumbnail(for: asset)
    let second = try XCTUnwrap(secondHit)
    XCTAssertTrue(second.isKnownDecodable, "a proven memory entry is served without a decode")
  }

  func testReplacingTheEntryDropsItsProof() async throws {
    let asset = try writeAsset(named: "replaced.png")
    try writeFreshDerivative(try Self.jpegBytes(width: 64, height: 48), for: asset)
    let cache = ThumbnailDiskCache.shared
    let hitHit = await cache.cachedThumbnail(for: asset)
    let hit = try XCTUnwrap(hitHit)
    await cache.markDecodable(hit)

    let replacement = try Self.jpegBytes(width: 32, height: 32)
    await cache.storeThumbnailData(replacement, for: asset)
    let afterStoreHit = await cache.cachedThumbnail(for: asset)
    let afterStore = try XCTUnwrap(afterStoreHit)
    XCTAssertEqual(afterStore.data, replacement)
    XCTAssertFalse(afterStore.isKnownDecodable)

    await cache.markDecodable(hit)
    let staleHit = await cache.cachedThumbnail(for: asset)
    let stale = try XCTUnwrap(staleHit)
    XCTAssertFalse(stale.isKnownDecodable, "a proof for the old bytes must not attach to new ones")
  }

  func testLoaderProvesUsableBytesAndRemovesUndecodableOnes() async throws {
    let good = try writeAsset(named: "good.png")
    let jpeg = try Self.jpegBytes(width: 64, height: 48)
    try writeFreshDerivative(jpeg, for: good)
    let served = await ThumbnailLoader.decodableCachedThumbnail(for: good)
    XCTAssertEqual(served, jpeg)
    let proven = await ThumbnailDiskCache.shared.cachedThumbnail(for: good)
    XCTAssertEqual(proven?.isKnownDecodable, true)

    let bad = try writeAsset(named: "bad.png")
    try writeFreshDerivative(Data([0xFF, 0xD8, 0x42, 0x99]), for: bad)
    let rejected = await ThumbnailLoader.decodableCachedThumbnail(for: bad)
    XCTAssertNil(rejected)
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: MapleSidecarPaths.thumbURL(for: bad).path),
      "an undecodable derivative is removed so the source can rebuild it")
  }

  func testThumbnailThisAppWroteIsServedWithoutTheReadabilityDecode() async throws {
    let asset = try writeAsset(named: "own.png")
    let jpeg = try Self.jpegBytes(width: 64, height: 48)
    await ThumbnailDiskCache().storeThumbnailData(jpeg, for: asset)

    let checksBefore = ThumbnailLoader.readabilityChecks.withLock { $0 }
    let served = await ThumbnailLoader.decodableCachedThumbnail(for: asset)

    XCTAssertEqual(served, jpeg)
    XCTAssertEqual(ThumbnailLoader.readabilityChecks.withLock { $0 }, checksBefore)
    let hit = await ThumbnailDiskCache.shared.cachedThumbnail(for: asset)
    XCTAssertEqual(hit?.isKnownDecodable, true)
  }

  func testOwnThumbnailTruncatedLaterIsCheckedAndDiscarded() async throws {
    let asset = try writeAsset(named: "truncated.png")
    let jpeg = try Self.jpegBytes(width: 64, height: 48)
    await ThumbnailDiskCache().storeThumbnailData(jpeg, for: asset)
    try jpeg.prefix(jpeg.count / 2).write(to: MapleSidecarPaths.thumbURL(for: asset))

    let checksBefore = ThumbnailLoader.readabilityChecks.withLock { $0 }
    let served = await ThumbnailLoader.decodableCachedThumbnail(for: asset)

    XCTAssertNil(served)
    XCTAssertEqual(ThumbnailLoader.readabilityChecks.withLock { $0 }, checksBefore + 1)
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: MapleSidecarPaths.thumbURL(for: asset).path))
  }

  func testUndecodableBytesThisAppWroteAreStillCheckedAndDiscarded() async throws {
    let asset = try writeAsset(named: "bad-encode.png")
    await ThumbnailDiskCache().storeThumbnailData(Data([0xFF, 0xD8, 0x42, 0x99]), for: asset)

    let served = await ThumbnailLoader.decodableCachedThumbnail(for: asset)

    XCTAssertNil(served, "a bad encode never earns the own-write proof")
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: MapleSidecarPaths.thumbURL(for: asset).path))
  }

  func testOwnThumbnailReplacedWithSameSizeButNewModificationTimeIsChecked() async throws {
    let asset = try writeAsset(named: "touched.png")
    let jpeg = try Self.jpegBytes(width: 64, height: 48)
    await ThumbnailDiskCache().storeThumbnailData(jpeg, for: asset)
    let thumb = MapleSidecarPaths.thumbURL(for: asset)
    try Data(repeating: 0x42, count: jpeg.count).write(to: thumb)
    try FileManager.default.setAttributes(
      [.modificationDate: Date(timeIntervalSince1970: 1_000)], ofItemAtPath: thumb.path)

    let checksBefore = ThumbnailLoader.readabilityChecks.withLock { $0 }
    let served = await ThumbnailLoader.decodableCachedThumbnail(for: asset)

    XCTAssertNil(served)
    XCTAssertEqual(ThumbnailLoader.readabilityChecks.withLock { $0 }, checksBefore + 1)
  }

  func testStampWithoutTheOwnWriteRecordStillParsesAndIsChecked() async throws {
    let asset = try writeAsset(named: "old-stamp.png")
    let jpeg = try Self.jpegBytes(width: 64, height: 48)
    try writeFreshDerivative(jpeg, for: asset)

    let checksBefore = ThumbnailLoader.readabilityChecks.withLock { $0 }
    let served = await ThumbnailLoader.decodableCachedThumbnail(for: asset)

    XCTAssertEqual(served, jpeg)
    XCTAssertEqual(ThumbnailLoader.readabilityChecks.withLock { $0 }, checksBefore + 1)
  }

  func testOwnWriteStampFollowsTheSourceSignature() async throws {
    let asset = try writeAsset(named: "source-moved.png")
    let jpeg = try Self.jpegBytes(width: 64, height: 48)
    await ThumbnailDiskCache().storeThumbnailData(jpeg, for: asset)
    try Data([9, 9, 9, 9]).write(to: asset)

    let miss = await ThumbnailDiskCache.shared.cachedThumbnail(for: asset)
    XCTAssertNil(miss, "an own-write stamp is still tied to the original it was made from")
  }

  private func writeAsset(named name: String) throws -> URL {
    let url = folder.appendingPathComponent(name)
    try Data([1, 2, 3]).write(to: url)
    return url
  }

  private func writeFreshDerivative(_ data: Data, for asset: URL) throws {
    let thumb = MapleSidecarPaths.thumbURL(for: asset)
    try FileManager.default.createDirectory(
      at: thumb.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: thumb)
    LocalDerivativeSourceStamp.record(thumb, for: asset)
  }

  private static func jpegBytes(width: Int, height: Int) throws -> Data {
    let context = try XCTUnwrap(
      CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
    context.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.8, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let image = try XCTUnwrap(context.makeImage())
    let out = NSMutableData()
    let dest = try XCTUnwrap(
      CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(dest, image, nil)
    XCTAssertTrue(CGImageDestinationFinalize(dest))
    return out as Data
  }
}
