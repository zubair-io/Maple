// ThumbnailLoaderServerWarmupTests — a Maple Cloud server that refuses the
// first screen of thumbnails while it warms up. The refused tiles must ask
// again rather than download their originals, a tile that does fall back to
// its original must not hold up other tiles' thumbnail requests, and a JPEG
// original must decode.

import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest

@testable import MapleCore

final class ThumbnailLoaderServerWarmupTests: XCTestCase {
  private actor WarmingSource: ImageSource {
    private let refusals: Int
    private(set) var thumbRequests = 0
    nonisolated var thumbnailsAreLatencyBound: Bool { true }

    init(refusals: Int) {
      self.refusals = refusals
    }

    func images() async throws -> [ImageRef] { [] }
    func thumb(for ref: ImageRef) async throws -> Data? {
      thumbRequests += 1
      guard thumbRequests > refusals else { throw NSError(domain: "CloudSource", code: 503) }
      return Data([0x01])
    }
    func preview(for ref: ImageRef) async throws -> Data? { nil }
    func rawBytes(for ref: ImageRef) async throws -> Data { throw CancellationError() }
    func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {}
    func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }
  }

  /// Answers that it has no thumbnail for any `fallback-*` asset and serves
  /// every other one.
  private actor PartlyEmptySource: ImageSource {
    nonisolated var thumbnailsAreLatencyBound: Bool { true }

    func images() async throws -> [ImageRef] { [] }
    func thumb(for ref: ImageRef) async throws -> Data? {
      ref.displayName.hasPrefix("fallback-") ? nil : Data([0x02])
    }
    func preview(for ref: ImageRef) async throws -> Data? { nil }
    func rawBytes(for ref: ImageRef) async throws -> Data { throw CancellationError() }
    func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {}
    func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }
  }

  private actor DownloadGate {
    private(set) var started = 0
    private var held: [CheckedContinuation<Void, Never>] = []

    func enter() async {
      started += 1
      await withCheckedContinuation { held.append($0) }
    }

    func releaseAll() {
      for continuation in held { continuation.resume() }
      held.removeAll()
    }
  }

  private actor DownloadCounter {
    private(set) var count = 0
    func record() { count += 1 }
  }

  private func makeAsset(
    named name: String = "warm.cr2", hint: String = "cr2",
    bytesProvider: @escaping AssetRef.BytesProvider
  ) -> (AssetRef, String) {
    let stableID = "fs:/library/warmup-\(UUID().uuidString)-\(name)"
    let asset = AssetRef(
      displayName: name, hintExtension: hint, stableID: stableID, bytesProvider: bytesProvider)
    return (asset, stableID)
  }

  private func jpegBytes(width: Int, height: Int) throws -> Data {
    let context = try XCTUnwrap(
      CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
    context.setFillColor(red: 0.8, green: 0.3, blue: 0.1, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let image = try XCTUnwrap(context.makeImage())
    let out = NSMutableData()
    let destination = try XCTUnwrap(
      CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, nil)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    return out as Data
  }

  func testRefusedThumbnailArrivesOnRetryWithoutDownloadingTheOriginal() async {
    let downloads = DownloadCounter()
    let (asset, stableID) = makeAsset(bytesProvider: {
      await downloads.record()
      throw URLError(.timedOut)
    })
    defer { removeSourcelessThumbCacheFile(forKey: stableID) }
    let source = WarmingSource(refusals: 1)
    let loader = ThumbnailLoader()

    let noWait: (Duration) async throws -> Void = { _ in }
    let result = await ThumbnailRetry.load(delays: ThumbnailRetry.serverDelays, sleep: noWait) {
      await loader.load(for: asset, from: source)
    }

    XCTAssertEqual(result, Data([0x01]))
    let requests = await source.thumbRequests
    let count = await downloads.count
    XCTAssertEqual(requests, 2, "the 503 is answered by asking again")
    XCTAssertEqual(count, 0, "a refused thumbnail never downloads the original")
  }

  func testAFallbackDownloadDoesNotHoldUpOtherTilesThumbnails() async throws {
    let gate = DownloadGate()
    let fallbacks = (0..<ThumbnailLoader.maxConcurrentSourceFetches).map { index in
      makeAsset(named: "fallback-\(index).cr2") {
        await gate.enter()
        throw URLError(.timedOut)
      }
    }
    let (served, servedID) = makeAsset(named: "served.cr2") { throw URLError(.timedOut) }
    defer {
      for fallback in fallbacks { removeSourcelessThumbCacheFile(forKey: fallback.1) }
      removeSourcelessThumbCacheFile(forKey: servedID)
    }
    let source = PartlyEmptySource()
    let loader = ThumbnailLoader()

    let fallbackCells = fallbacks.map { asset in
      Task { await loader.load(for: asset.0, from: source) }
    }
    let deadline = ContinuousClock.now + .seconds(5)
    while await gate.started < ThumbnailLoader.maxConcurrentDecodes,
      ContinuousClock.now < deadline
    {
      try await Task.sleep(for: .milliseconds(5))
    }

    let servedCell = Task { await loader.load(for: served, from: source) }
    let watchdog = Task {
      try await Task.sleep(for: .seconds(5))
      await gate.releaseAll()
    }
    let result = await servedCell.value
    let downloadsWhenServed = await gate.started
    watchdog.cancel()

    XCTAssertEqual(result, Data([0x02]))
    XCTAssertEqual(
      downloadsWhenServed, ThumbnailLoader.maxConcurrentDecodes,
      "the served tile got its thumbnail while every fallback still waited on its download")

    let drainDeadline = ContinuousClock.now + .seconds(10)
    while await gate.started < fallbacks.count, ContinuousClock.now < drainDeadline {
      await gate.releaseAll()
      try await Task.sleep(for: .milliseconds(5))
    }
    await gate.releaseAll()
    for cell in fallbackCells { _ = await cell.value }
  }

  func testJPEGOriginalDecodesInTheFallback() async throws {
    let jpeg = try jpegBytes(width: 1200, height: 800)
    let (asset, stableID) = makeAsset(named: "fallback-photo.jpg", hint: "jpg") { jpeg }
    defer { removeSourcelessThumbCacheFile(forKey: stableID) }

    let result = await ThumbnailLoader().load(for: asset, from: PartlyEmptySource())

    let data = try XCTUnwrap(
      result, "a JPEG original renders through ImageIO, not the RAW developer")
    let image = try XCTUnwrap(
      CGImageSourceCreateWithData(data as CFData, nil).flatMap {
        CGImageSourceCreateImageAtIndex($0, 0, nil)
      })
    XCTAssertEqual(max(image.width, image.height), Int(ThumbnailDiskCache.defaultThumbSize.width))
  }

  func testJPEGFallbackAlsoEncodesTheSharedSize() throws {
    let jpeg = try jpegBytes(width: 1200, height: 800)
    let encoded = try XCTUnwrap(ThumbnailLoader.fallbackThumbnails(from: jpeg, hint: "JPG"))
    let shared = try XCTUnwrap(
      encoded.onShare.flatMap { CGImageSourceCreateWithData($0 as CFData, nil) }.flatMap {
        CGImageSourceCreateImageAtIndex($0, 0, nil)
      })
    XCTAssertEqual(shared.width, Int(MapleThumbCacheKey.onShareThumbLongEdgePx))
  }

  func testAnOriginalThatCannotRenderIsDownloadedOnce() async {
    let downloads = DownloadCounter()
    let (asset, stableID) = makeAsset(named: "fallback-broken.jpg", hint: "jpg") {
      await downloads.record()
      return Data("not an image".utf8)
    }
    defer { removeSourcelessThumbCacheFile(forKey: stableID) }
    let loader = ThumbnailLoader()
    let source = PartlyEmptySource()

    let first = await loader.load(for: asset, from: source)
    let second = await loader.load(for: asset, from: source)

    XCTAssertNil(first)
    XCTAssertNil(second)
    let count = await downloads.count
    XCTAssertEqual(count, 1, "a retry asks the server again but does not re-download")
  }
}
