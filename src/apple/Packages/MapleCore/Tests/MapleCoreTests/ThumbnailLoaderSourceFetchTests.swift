// ThumbnailLoaderSourceFetchTests — #6008. A server thumbnail is a small
// network read: it must not queue behind the on-device decode gate, and a
// failure to reach the server must not turn into a full-original download.

import XCTest

@testable import MapleCore

final class ThumbnailLoaderSourceFetchTests: XCTestCase {
  private actor ConcurrencyProbe {
    private(set) var started = 0
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func enter() async {
      started += 1
      await withCheckedContinuation { waiting.append($0) }
    }

    func releaseAll() {
      waiting.forEach { $0.resume() }
      waiting.removeAll()
    }
  }

  private actor HeldSource: ImageSource {
    let probe = ConcurrencyProbe()
    nonisolated let thumbnailsAreLatencyBound: Bool

    init(latencyBound: Bool) {
      thumbnailsAreLatencyBound = latencyBound
    }

    func images() async throws -> [ImageRef] { [] }
    func thumb(for ref: ImageRef) async throws -> Data? {
      await probe.enter()
      return Data([0x01])
    }
    func preview(for ref: ImageRef) async throws -> Data? { nil }
    func rawBytes(for ref: ImageRef) async throws -> Data { throw CancellationError() }
    func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {}
    func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }
  }

  private actor FailingSource: ImageSource {
    let failure: any Error & Sendable
    nonisolated var thumbnailsAreLatencyBound: Bool { true }

    init(failure: any Error & Sendable) {
      self.failure = failure
    }

    func images() async throws -> [ImageRef] { [] }
    func thumb(for ref: ImageRef) async throws -> Data? { throw failure }
    func preview(for ref: ImageRef) async throws -> Data? { nil }
    func rawBytes(for ref: ImageRef) async throws -> Data { throw failure }
    func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {}
    func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }
  }

  private actor EmptySource: ImageSource {
    private(set) var thumbRequests = 0
    nonisolated var thumbnailsAreLatencyBound: Bool { true }

    func images() async throws -> [ImageRef] { [] }
    func thumb(for ref: ImageRef) async throws -> Data? {
      thumbRequests += 1
      return nil
    }
    func preview(for ref: ImageRef) async throws -> Data? { nil }
    func rawBytes(for ref: ImageRef) async throws -> Data { throw CancellationError() }
    func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {}
    func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }
  }

  private actor DownloadCounter {
    private(set) var count = 0
    func record() { count += 1 }
  }

  private func makeAsset(bytesProvider: @escaping AssetRef.BytesProvider) -> (AssetRef, String) {
    let stableID = "fs:/library/fetch-\(UUID().uuidString).dng"
    let asset = AssetRef(
      displayName: "fetch.dng", hintExtension: "dng", stableID: stableID,
      bytesProvider: bytesProvider)
    return (asset, stableID)
  }

  func testServerFetchesRunWiderThanTheDecodeGate() async {
    let fetchCount = ThumbnailLoader.maxConcurrentDecodes + 2
    XCTAssertLessThanOrEqual(fetchCount, ThumbnailLoader.maxConcurrentSourceFetches)
    let source = HeldSource(latencyBound: true)
    let loader = ThumbnailLoader()
    let assets = (0..<fetchCount).map { _ in
      makeAsset(bytesProvider: { throw URLError(.notConnectedToInternet) })
    }
    defer { assets.forEach { removeSourcelessThumbCacheFile(forKey: $0.1) } }

    let cells = assets.map { asset in Task { await loader.load(for: asset.0, from: source) } }
    let deadline = ContinuousClock.now + .seconds(5)
    var started = 0
    while ContinuousClock.now < deadline {
      started = await source.probe.started
      if started == fetchCount { break }
      try? await Task.sleep(for: .milliseconds(5))
    }
    XCTAssertEqual(started, fetchCount, "every fetch is on the wire at once")

    await source.probe.releaseAll()
    for cell in cells { _ = await cell.value }
  }

  func testDecodeBoundSourcesStayOnTheDecodeGate() async {
    let fetchCount = ThumbnailLoader.maxConcurrentDecodes + 2
    let source = HeldSource(latencyBound: false)
    let loader = ThumbnailLoader()
    let assets = (0..<fetchCount).map { _ in
      makeAsset(bytesProvider: { throw URLError(.notConnectedToInternet) })
    }
    defer { assets.forEach { removeSourcelessThumbCacheFile(forKey: $0.1) } }

    let cells = assets.map { asset in Task { await loader.load(for: asset.0, from: source) } }
    let deadline = ContinuousClock.now + .seconds(5)
    while ContinuousClock.now < deadline {
      if await source.probe.started == ThumbnailLoader.maxConcurrentDecodes { break }
      try? await Task.sleep(for: .milliseconds(5))
    }
    try? await Task.sleep(for: .milliseconds(100))
    let started = await source.probe.started
    XCTAssertEqual(started, ThumbnailLoader.maxConcurrentDecodes, "PhotoKit and SMB keep the decode cap")

    while await source.probe.started < fetchCount {
      await source.probe.releaseAll()
      try? await Task.sleep(for: .milliseconds(5))
    }
    await source.probe.releaseAll()
    for cell in cells { _ = await cell.value }
  }

  func testFallbackForAScrolledAwayCellNeverDownloadsTheOriginal() async throws {
    let downloads = DownloadCounter()
    let (asset, stableID) = makeAsset(bytesProvider: {
      await downloads.record()
      throw URLError(.timedOut)
    })
    defer { removeSourcelessThumbCacheFile(forKey: stableID) }
    let source = EmptySource()
    let loader = ThumbnailLoader()
    for _ in 0..<ThumbnailLoader.maxConcurrentDecodes { try await loader.acquireDecodeSlot() }

    let cell = Task { await loader.load(for: asset, from: source) }
    let deadline = ContinuousClock.now + .seconds(5)
    while await source.thumbRequests == 0, ContinuousClock.now < deadline {
      try? await Task.sleep(for: .milliseconds(5))
    }
    try? await Task.sleep(for: .milliseconds(50))
    cell.cancel()
    try? await Task.sleep(for: .milliseconds(50))
    for _ in 0..<ThumbnailLoader.maxConcurrentDecodes { await loader.releaseDecodeSlot() }
    _ = await cell.value

    let count = await downloads.count
    XCTAssertEqual(count, 0, "a cell that scrolled away while the decode gate was full gets no RAW download")
  }

  func testUnreachableServerDoesNotDownloadTheOriginal() async {
    let downloads = DownloadCounter()
    let (asset, stableID) = makeAsset(bytesProvider: {
      await downloads.record()
      throw URLError(.timedOut)
    })
    defer { removeSourcelessThumbCacheFile(forKey: stableID) }

    let result = await ThumbnailLoader().load(
      for: asset, from: FailingSource(failure: URLError(.timedOut)))

    XCTAssertNil(result)
    let count = await downloads.count
    XCTAssertEqual(count, 0, "a timed-out thumbnail must not fall back to the full original")
  }

  func testServerWithNoThumbnailStillFallsBackToTheOriginal() async {
    let downloads = DownloadCounter()
    let (asset, stableID) = makeAsset(bytesProvider: {
      await downloads.record()
      throw URLError(.timedOut)
    })
    defer { removeSourcelessThumbCacheFile(forKey: stableID) }

    _ = await ThumbnailLoader().load(for: asset, from: EmptySource())

    let count = await downloads.count
    XCTAssertEqual(
      count, 1, "a server that answered it has no thumbnail still gets the local fallback")
  }

  func testTransientClassification() {
    XCTAssertTrue(ThumbnailLoader.isTransientSourceFailure(URLError(.networkConnectionLost)))
    XCTAssertTrue(ThumbnailLoader.isTransientSourceFailure(CancellationError()))
    XCTAssertTrue(
      ThumbnailLoader.isTransientSourceFailure(
        AuthenticatedHTTPClient.AuthenticationError.temporarilyUnavailable))
    for status in [202, 503, 524] {
      XCTAssertTrue(
        ThumbnailLoader.isTransientSourceFailure(NSError(domain: "CloudSource", code: status)))
    }
    XCTAssertFalse(
      ThumbnailLoader.isTransientSourceFailure(NSError(domain: "CloudSource", code: 422)))
    XCTAssertFalse(ThumbnailLoader.isTransientSourceFailure(NSError(domain: "Other", code: 503)))
  }
}
