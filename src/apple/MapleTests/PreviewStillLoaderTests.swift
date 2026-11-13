import CoreGraphics
import ImageIO
import MapleCore
import UniformTypeIdentifiers
import XCTest

@testable import Maple

/// #5762 ports of the Preview page's still loading (#3957, #5432): a saved
/// edit reloads both tiers, and a failed display tier is retried until it
/// lands, or stops on "not found".
@MainActor
final class PreviewStillLoaderTests: XCTestCase {
  func testASaveReloadsTheThumbnailAndTheDisplayTier() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("photo.png")
    try encodedImage(size: 32).write(to: url)
    await ThumbnailDiskCache.shared.configure(folderURL: directory)
    await ThumbnailDiskCache.shared.storeThumbnailData(try encodedImage(size: 8), for: url)
    let sink = LocalDisplayPreviewSink(previewURL: MapleSidecarPaths.previewURL(for: url))
    await sink.write(try encodedImage(size: 32))

    let loader = PreviewStillLoader(asset: AssetRef(url: url), source: nil, provider: .local())
    loader.prepare(for: loader.reloadKey)
    await loader.loadFirstPaint(displayTierDimension: 2048, isVisible: true)
    XCTAssertEqual(loader.image?.width, 8)
    await loader.loadDisplayTier(maxDimension: 2048)
    XCTAssertEqual(loader.image?.width, 32)
    XCTAssertTrue(loader.isDisplayTierSettled)

    let before = loader.reloadKey
    await ThumbnailDiskCache.shared.storeThumbnailData(try encodedImage(size: 16), for: url)
    await sink.write(try encodedImage(size: 64))
    DevelopedImageRevision.shared.didPersist(for: url)
    XCTAssertNotEqual(loader.reloadKey, before, "the page's loads restart")

    loader.prepare(for: loader.reloadKey)
    XCTAssertEqual(loader.image?.width, 32, "the old still stays until the new one lands")
    XCTAssertFalse(loader.isDisplayTierSettled)
    loader.prepare(for: loader.reloadKey)
    XCTAssertFalse(loader.isDisplayTierSettled, "the second load of the reload resets nothing")
    await loader.loadFirstPaint(displayTierDimension: 2048, isVisible: true)
    XCTAssertEqual(loader.image?.width, 16)
    await loader.loadDisplayTier(maxDimension: 2048)
    XCTAssertEqual(loader.image?.width, 64)
  }

  /// #5764: the editor's still holds until something at least as sharp lands,
  /// and never stands in for the display tier, which still loads.
  func testAStillHandedBackKeepsItsPlaceUntilTheDisplayTierLands() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("photo.png")
    try encodedImage(size: 40).write(to: url)
    await ThumbnailDiskCache.shared.configure(folderURL: directory)
    await ThumbnailDiskCache.shared.storeThumbnailData(try encodedImage(size: 8), for: url)
    let sink = LocalDisplayPreviewSink(previewURL: MapleSidecarPaths.previewURL(for: url))
    await sink.write(try encodedImage(size: 40))
    let handed = try XCTUnwrap(
      CGImageSourceCreateWithData(try encodedImage(size: 24) as CFData, nil).flatMap {
        CGImageSourceCreateImageAtIndex($0, 0, nil)
      })

    let loader = PreviewStillLoader(asset: AssetRef(url: url), source: nil, provider: .local())
    loader.showHandedOff(CanvasHandoffStill(image: handed, isDisplayPreview: true))
    loader.prepare(for: loader.reloadKey)
    await loader.loadFirstPaint(displayTierDimension: 2048, isVisible: true)
    XCTAssertTrue(loader.image === handed, "the smaller thumbnail does not replace it")
    XCTAssertFalse(loader.isDisplayTierSettled)
    await loader.loadDisplayTier(maxDimension: 2048)
    XCTAssertEqual(loader.image?.width, 40)
  }

  func testAFailedDisplayTierIsRetriedUntilItLands() async throws {
    let script = OutcomeScript([.indexing(retryAfter: 0), .data(try encodedImage(size: 48))])
    let loader = PreviewStillLoader(
      asset: makeCloudRef(script: script), source: nil, provider: .local())
    await loader.loadDisplayTier(maxDimension: 2048)
    XCTAssertEqual(loader.image?.width, 48, "the 202 must be retried, not final")
    let calls = await script.calls
    XCTAssertEqual(calls, 2)
  }

  func testANotFoundDisplayTierSettlesWithoutRetrying() async throws {
    let script = OutcomeScript([.notFound(reason: "http 404")])
    let loader = PreviewStillLoader(
      asset: makeCloudRef(script: script), source: nil, provider: .local())
    await loader.loadDisplayTier(maxDimension: 2048)
    XCTAssertTrue(loader.isDisplayTierSettled, "zooming past the still may now render")
    await loader.loadDisplayTier(maxDimension: 2048)
    let calls = await script.calls
    XCTAssertEqual(calls, 1, "a revisit does not repeat the 404")
  }

  func testATransientFailureLetsTheRenderStartWhileItRetries() async throws {
    let script = OutcomeScript([.indexing(retryAfter: 30)])
    let loader = PreviewStillLoader(
      asset: makeCloudRef(script: script), source: nil, provider: .local())
    let retrying = Task { await loader.loadDisplayTier(maxDimension: 2048) }
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while !loader.isDisplayTierSettled, ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(10))
    }
    retrying.cancel()
    XCTAssertTrue(loader.isDisplayTierSettled)
    XCTAssertNil(loader.image)
  }

  /// A single-tier source's display tier is one artifact: the visible page's
  /// own display-tier load fetches it, so its first paint must not as well.
  func testTheVisiblePageDoesNotFetchASingleTierTwice() async throws {
    let script = OutcomeScript([.data(try encodedImage(size: 48))])
    let visible = PreviewStillLoader(
      asset: makeCloudRef(script: script), source: nil, provider: .local())
    await visible.loadFirstPaint(displayTierDimension: 2048, isVisible: true)
    let afterVisible = await script.calls
    XCTAssertEqual(afterVisible, 0)

    let neighbour = PreviewStillLoader(
      asset: makeCloudRef(script: script), source: nil, provider: .local())
    await neighbour.loadFirstPaint(displayTierDimension: 2048, isVisible: false)
    XCTAssertEqual(neighbour.image?.width, 48, "a neighbour with no thumbnail still paints")
  }

  // MARK: Fixtures

  private func makeCloudRef(script: OutcomeScript) -> AssetRef {
    let id = "fs:/srv/photos/Library/IMG_\(UUID().uuidString).dng"
    return AssetRef(
      displayName: "IMG_0.dng",
      hintExtension: "dng",
      stableID: id,
      thumbnailProvenance: .cloud(server: URL(string: "https://a.example.invalid")!),
      displayPreviewProvider: { await script.next() },
      bytesProvider: { Data() }
    )
  }

  private func encodedImage(size: Int) throws -> Data {
    let context = try XCTUnwrap(
      CGContext(
        data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    context.setFillColor(CGColor(red: 0, green: 0.6, blue: 0.2, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: size, height: size))
    let image = try XCTUnwrap(context.makeImage())
    let data = NSMutableData()
    let destination = try XCTUnwrap(
      CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, nil)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    return data as Data
  }
}

/// Serves scripted display-tier outcomes in order, repeating the last.
private actor OutcomeScript {
  private let outcomes: [PreviewFetchOutcome]
  private(set) var calls = 0

  init(_ outcomes: [PreviewFetchOutcome]) { self.outcomes = outcomes }

  func next() -> PreviewFetchOutcome {
    defer { calls += 1 }
    return outcomes[min(calls, outcomes.count - 1)]
  }
}
