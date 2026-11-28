// StaleCloudThumbnailRefreshTests — #6175: a cached cloud thumbnail whose
// server token is out of date is shown at once and refetched once per launch,
// and the new pixels reach every cell showing that photo, whenever it was made.

import ImageIO
import UniformTypeIdentifiers
import XCTest

@testable import MapleCore

func waitUntil(
  timeout: Duration = .seconds(10), file: StaticString = #filePath, line: UInt = #line,
  _ condition: () async -> Bool
) async {
  let deadline = ContinuousClock.now + timeout
  while ContinuousClock.now < deadline {
    if await condition() { return }
    try? await Task.sleep(for: .milliseconds(5))
  }
  XCTFail("timed out waiting for a condition", file: file, line: line)
}

final class StaleCloudThumbnailRefreshTests: XCTestCase {
  private enum Answer {
    case bytes(Data)
    case serverNotReady
    case held
  }

  private actor Source: ImageSource {
    private(set) var requestedIDs: [String] = []
    private(set) var peakInFlight = 0
    private(set) var lastRef: ImageRef?
    private var inFlight = 0
    private var answer: Answer
    private var heldRequests: [CheckedContinuation<Void, Never>] = []
    private let token: String

    var requests: Int { requestedIDs.count }

    init(token: String, answer: Answer) {
      self.token = token
      self.answer = answer
    }

    nonisolated func thumbToken(for ref: ImageRef) -> String? { token }

    func release(with bytes: Data) {
      answer = .bytes(bytes)
      for request in heldRequests { request.resume() }
      heldRequests.removeAll()
    }

    func images() async throws -> [ImageRef] { [] }
    func thumb(for ref: ImageRef) async throws -> Data? {
      requestedIDs.append(ref.id)
      lastRef = ref
      inFlight += 1
      peakInFlight = max(peakInFlight, inFlight)
      defer { inFlight -= 1 }
      if case .held = answer { await withCheckedContinuation { heldRequests.append($0) } }
      switch answer {
      case .bytes(let bytes): return bytes
      case .serverNotReady: throw NSError(domain: "CloudSource", code: 503)
      case .held: return nil
      }
    }
    func preview(for ref: ImageRef) async throws -> Data? { nil }
    func rawBytes(for ref: ImageRef) async throws -> Data { Data() }
    func writeXMP(_ sidecar: Sidecar, for ref: ImageRef) async throws {}
    func search(_ query: SearchQuery) async throws -> [ImageRef]? { nil }
  }

  private final class Broadcasts: @unchecked Sendable {
    private let lock = NSLock()
    private var notifications: [Notification] = []
    private var observer: NSObjectProtocol?

    init() {
      observer = NotificationCenter.default.addObserver(
        forName: ThumbnailRefresh.didRefresh, object: nil, queue: nil
      ) { [self] notification in lock.withLock { notifications.append(notification) } }
    }

    deinit { observer.map(NotificationCenter.default.removeObserver) }

    func received(by source: ThumbnailSource) -> Int {
      lock.withLock { notifications.filter { ThumbnailRefresh.reloads(source, on: $0) }.count }
    }
  }

  private let oldBytes = StaleCloudThumbnailRefreshTests.jpeg(side: 8)
  private let newBytes = StaleCloudThumbnailRefreshTests.jpeg(side: 16)
  private var keys: [String] = []
  private var bitmapKeys: [String] = []

  override func tearDown() async throws {
    for key in keys {
      removeSourcelessThumbCacheFile(forKey: key)
      try? FileManager.default.removeItem(
        at: sourcelessThumbCacheFileURL(forKey: key).appendingPathExtension("source"))
    }
    keys = []
  }

  private static func jpeg(side: Int) -> Data {
    let context = CGContext(
      data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    context.setFillColor(red: 0.8, green: 0.4, blue: 0.2, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: side, height: side))
    let output = NSMutableData()
    let destination = CGImageDestinationCreateWithData(
      output, UTType.jpeg.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    CGImageDestinationFinalize(destination)
    return output as Data
  }

  private func staleAsset(onServer server: String? = nil) async -> (
    asset: AssetRef, key: String, source: ThumbnailSource
  ) {
    let key = "fs:/srv/photos/\(UUID().uuidString).dng"
    keys.append(key)
    await ThumbnailDiskCache.shared.storeThumbnailData(oldBytes, forKey: key, token: "t1")
    let asset = AssetRef(
      displayName: "x.dng", hintExtension: "dng", stableID: key,
      thumbnailProvenance: server.map { .cloud(server: URL(string: $0)!) },
      bytesProvider: { Data() })
    return (asset, key, .local(asset, source: nil))
  }

  private func loader(finishing finished: FinishedStaleRefreshes) async -> ThumbnailLoader {
    let loader = ThumbnailLoader()
    await loader.setStaleRefreshDidFinish { finished.record($0) }
    return loader
  }

  func testStaleThumbnailIsShownWhileTheServerIsNotReadyAndIsNotAskedAgain() async {
    let (asset, key, _) = await staleAsset()
    let source = Source(token: "t2", answer: .serverNotReady)
    let finished = FinishedStaleRefreshes()
    let loader = await loader(finishing: finished)

    let first = await loader.load(for: asset, from: source)
    await waitUntil { finished.contains(key) }
    let second = await loader.load(for: asset, from: source)
    let third = await loader.load(for: asset, from: source)

    let requests = await source.requests
    XCTAssertEqual(first, oldBytes)
    XCTAssertEqual(second, oldBytes)
    XCTAssertEqual(third, oldBytes)
    XCTAssertEqual(requests, 1, "a failed refetch is not retried within the launch")
    XCTAssertEqual(ThumbnailDiskCache.shared.syncPeekData(forKey: key), oldBytes)
    let recorded = await ThumbnailDiskCache.shared.thumbnailData(forKey: key, currentToken: "t2")
    XCTAssertNil(recorded, "the new token is not recorded")
  }

  func testStaleThumbnailIsShownWhileASlowRequestIsPendingThenEveryCellIsToldOfTheNewBytes()
    async
  {
    let (asset, key, shown) = await staleAsset()
    let source = Source(token: "t2", answer: .held)
    let finished = FinishedStaleRefreshes()
    let loader = await loader(finishing: finished)
    let broadcasts = Broadcasts()

    let first = await loader.load(for: asset, from: source)
    await waitUntil { await source.requests == 1 }
    XCTAssertEqual(first, oldBytes)
    XCTAssertEqual(broadcasts.received(by: shown), 0)

    let second = await loader.load(for: asset, from: source)
    await source.release(with: newBytes)
    await waitUntil { finished.contains(key) }

    let current = await ThumbnailDiskCache.shared.thumbnailData(forKey: key, currentToken: "t2")
    let requests = await source.requests
    XCTAssertEqual(second, oldBytes)
    XCTAssertEqual(requests, 1, "cells showing one photo share a single refetch")
    XCTAssertEqual(current, newBytes)
    XCTAssertEqual(broadcasts.received(by: shown), 1)
  }

  func testIdenticalBytesStoreTheTokenWithoutABroadcast() async {
    let (asset, key, shown) = await staleAsset()
    let source = Source(token: "t2", answer: .bytes(oldBytes))
    let finished = FinishedStaleRefreshes()
    let loader = await loader(finishing: finished)
    let broadcasts = Broadcasts()

    _ = await loader.load(for: asset, from: source)
    await waitUntil { finished.contains(key) }

    let current = await ThumbnailDiskCache.shared.thumbnailData(forKey: key, currentToken: "t2")
    XCTAssertEqual(broadcasts.received(by: shown), 0)
    XCTAssertEqual(current, oldBytes)
  }

  func testRefetchRequestCarriesTheSmbLocationOfTheAsset() async {
    let key = "fs:/srv/photos/\(UUID().uuidString).dng"
    keys.append(key)
    await ThumbnailDiskCache.shared.storeThumbnailData(oldBytes, forKey: key, token: "t1")
    let smbSourceID = UUID()
    let asset = AssetRef(
      displayName: "x.dng", hintExtension: "dng", stableID: key, smbPath: "share/x.dng",
      smbSourceID: smbSourceID, bytesProvider: { Data() })
    let source = Source(token: "t2", answer: .serverNotReady)
    let finished = FinishedStaleRefreshes()
    let loader = await loader(finishing: finished)

    _ = await loader.load(for: asset, from: source)
    await waitUntil { finished.contains(key) }

    let ref = await source.lastRef
    XCTAssertEqual(ref?.smbPath, "share/x.dng")
    XCTAssertEqual(ref?.smbSourceID, smbSourceID)
  }

  func testOnlyACellShowingTheRefreshedPhotoReloads() async {
    let (asset, key, shown) = await staleAsset()
    let other = await staleAsset().source
    let source = Source(token: "t2", answer: .bytes(newBytes))
    let finished = FinishedStaleRefreshes()
    let loader = await loader(finishing: finished)
    let broadcasts = Broadcasts()

    _ = await loader.load(for: asset, from: source)
    await waitUntil { finished.contains(key) }

    XCTAssertEqual(broadcasts.received(by: shown), 1)
    XCTAssertEqual(broadcasts.received(by: other), 0)
    XCTAssertEqual(broadcasts.received(by: .photoKit(localID: "ph-1")), 0)
  }

  func testACellCreatedAfterTheRefreshReadsTheNewPixels() async {
    let (asset, key, shown) = await staleAsset()
    let source = Source(token: "t2", answer: .held)
    let finished = FinishedStaleRefreshes()
    let loader = await loader(finishing: finished)
    let liveCell = "cell-\(UUID().uuidString)"
    ThumbnailRefresh.track(bitmapKey: liveCell, for: shown)
    let staleImage = await ThumbnailDecoder.image(for: oldBytes, key: liveCell)
    XCTAssertEqual(staleImage?.width, 8)

    _ = await loader.load(for: asset, from: source)
    await waitUntil { await source.requests == 1 }
    await source.release(with: newBytes)
    await waitUntil { finished.contains(key) }

    let rebuiltCell = "cell-\(UUID().uuidString)"
    let live = ThumbnailDecoder.cachedImage(forKey: liveCell)
    let rebuilt = await ThumbnailRefresh.refreshedImage(for: shown, bitmapKey: rebuiltCell)
    let reloaded = await loader.load(for: asset, from: source)
    XCTAssertEqual(live?.width, 16, "the bitmap is replaced before the broadcast")
    XCTAssertEqual(rebuilt?.width, 16, "a cell built after the refresh reads the fresh bytes")
    XCTAssertEqual(reloaded, newBytes)
  }

  func testAnUntrackedStaleBitmapIsReplacedForItsCell() async {
    let (_, key, shown) = await staleAsset()
    await ThumbnailDiskCache.shared.storeThumbnailData(newBytes, forKey: key, token: "t2")
    let cell = "cell-\(UUID().uuidString)"
    let stale = await ThumbnailDecoder.image(for: oldBytes, key: cell)
    XCTAssertEqual(stale?.width, 8)

    let refreshed = await ThumbnailRefresh.refreshedImage(for: shown, bitmapKey: cell)

    XCTAssertEqual(refreshed?.width, 16)
    XCTAssertEqual(ThumbnailDecoder.cachedImage(forKey: cell)?.width, 16)
  }

  func testABitmapForgottenByTheRegistryIsDroppedFromTheDecoder() async {
    let (_, _, first) = await staleAsset()
    let forgotten = "cell-\(UUID().uuidString)"
    _ = await ThumbnailDecoder.image(for: oldBytes, key: forgotten)
    ThumbnailRefresh.track(bitmapKey: forgotten, for: first)

    for _ in 0..<1024 {
      ThumbnailRefresh.track(bitmapKey: "cell-\(UUID().uuidString)", for: await staleAsset().source)
    }

    XCTAssertNil(ThumbnailDecoder.cachedImage(forKey: forgotten))
  }

  func testACellSwitchingItemsIgnoresARefreshOfTheNewPhoto() async {
    let (_, key, shown) = await staleAsset()
    let event = Notification(
      name: ThumbnailRefresh.didRefresh, userInfo: ["thumbnailKey": key])
    let previous = ThumbnailRefresh.ShownBitmap(loadKey: "old-photo", bitmapKey: "old-bitmap")
    let current = ThumbnailRefresh.ShownBitmap(loadKey: "new-photo", bitmapKey: "new-bitmap")

    XCTAssertNil(
      ThumbnailRefresh.bitmapKey(
        toRefresh: shown, loadKey: "new-photo", shown: previous, on: event),
      "the previous item's bitmap key must not be refreshed")
    XCTAssertNil(
      ThumbnailRefresh.bitmapKey(toRefresh: shown, loadKey: "new-photo", shown: nil, on: event))
    XCTAssertEqual(
      ThumbnailRefresh.bitmapKey(toRefresh: shown, loadKey: "new-photo", shown: current, on: event),
      "new-bitmap")
  }

  func testACacheCheckAndStoreCannotOverwriteAConcurrentReplace() throws {
    let old = try XCTUnwrap(ThumbnailDecoder.decodeSync(oldBytes))
    let new = try XCTUnwrap(ThumbnailDecoder.decodeSync(newBytes))
    let keys = (0..<2000).map { _ in "cell-\(UUID().uuidString)" }

    DispatchQueue.concurrentPerform(iterations: keys.count * 2) { index in
      let key = keys[index / 2]
      if index.isMultiple(of: 2) {
        _ = ThumbnailDecoder.storeUnlessCached(old, forKey: key as NSString)
      } else {
        ThumbnailDecoder.storeReplacing(new, keys: [key])
      }
    }

    let stale = keys.filter { ThumbnailDecoder.cachedImage(forKey: $0)?.width != 16 }
    XCTAssertTrue(stale.isEmpty, "\(stale.count) keys kept the old bitmap")
  }

  func testALateDecodeDoesNotOverwriteARefreshedImage() async throws {
    let bitmapKey = "cell-\(UUID().uuidString)"
    let lateOldImage = try XCTUnwrap(ThumbnailDecoder.decodeSync(oldBytes))
    let refreshed = await ThumbnailDecoder.replaceImage(for: newBytes, keys: [bitmapKey])

    let applied = ThumbnailDecoder.latest(lateOldImage, forKey: bitmapKey)

    XCTAssertEqual(refreshed?.width, 16)
    XCTAssertEqual(applied.width, 16)
    XCTAssertEqual(
      ThumbnailDecoder.latest(lateOldImage, forKey: "cell-\(UUID().uuidString)").width, 8,
      "an uncached key keeps the decoded image")
  }

  private func uncachedAsset() -> AssetRef {
    let key = "fs:/srv/photos/\(UUID().uuidString).dng"
    keys.append(key)
    return AssetRef(
      displayName: "x.dng", hintExtension: "dng", stableID: key, bytesProvider: { Data() })
  }

  func testARefetchWaitsForAForegroundFetchThenRuns() async {
    let (stale, key, _) = await staleAsset()
    let source = Source(token: "t2", answer: .held)
    let finished = FinishedStaleRefreshes()
    let loader = await loader(finishing: finished)
    let foreground = uncachedAsset()

    let shown = Task { await loader.load(for: foreground, from: source) }
    await waitUntil { await source.requests == 1 }
    _ = await loader.load(for: stale, from: source)

    let queued = await loader.pendingStaleRefetches.count
    let running = await loader.runningStaleRefetches
    XCTAssertEqual(queued, 1, "the refetch stays queued")
    XCTAssertEqual(running, 0, "no refetch starts while a foreground fetch waits")

    await source.release(with: newBytes)
    _ = await shown.value
    await waitUntil { finished.contains(key) }
    let requests = await source.requests
    XCTAssertEqual(requests, 2, "the refetch runs once the foreground is idle")
  }

  func testARefetchWaitsWhileTheServerIsNotReadyUntilARequestSucceeds() async {
    let (first, firstKey, _) = await staleAsset()
    let (second, secondKey, _) = await staleAsset()
    let source = Source(token: "t2", answer: .serverNotReady)
    let finished = FinishedStaleRefreshes()
    let loader = await loader(finishing: finished)

    _ = await loader.load(for: first, from: source)
    await waitUntil { finished.contains(firstKey) }
    _ = await loader.load(for: second, from: source)

    let queued = await loader.pendingStaleRefetches.count
    let running = await loader.runningStaleRefetches
    let requestsWhileNotReady = await source.requests
    XCTAssertEqual(queued, 1, "the refetch stays queued")
    XCTAssertEqual(running, 0, "no refetch starts after a 202 or 5xx")
    XCTAssertEqual(requestsWhileNotReady, 1)

    await source.release(with: newBytes)
    _ = await loader.load(for: uncachedAsset(), from: source)
    await waitUntil { finished.contains(secondKey) }
    let requests = await source.requests
    XCTAssertEqual(requests, 3, "the queued refetch runs after a request succeeds")
  }

  func testARefreshOfOneServersPhotoDoesNotReachTheSamePathOnAnotherServer() async throws {
    let key = "fs:/srv/photos/\(UUID().uuidString).dng"
    keys.append(key)
    func asset(on server: String) -> ThumbnailSource {
      .local(
        AssetRef(
          displayName: "x.dng", hintExtension: "dng", stableID: key,
          thumbnailProvenance: .cloud(server: URL(string: server)!), bytesProvider: { Data() }),
        source: nil)
    }
    let first = asset(on: "https://a.example")
    let second = asset(on: "https://b.example")
    let secondBitmap = "cell-\(UUID().uuidString)"
    _ = await ThumbnailDecoder.image(for: oldBytes, key: secondBitmap)
    ThumbnailRefresh.track(bitmapKey: secondBitmap, for: second)
    let firstBitmap = "cell-\(UUID().uuidString)"
    _ = await ThumbnailDecoder.image(for: oldBytes, key: firstBitmap)
    ThumbnailRefresh.track(bitmapKey: firstBitmap, for: first)
    let broadcasts = Broadcasts()

    await ThumbnailRefresh.publish(assetKey: try XCTUnwrap(first.refreshKey), bytes: newBytes)

    XCTAssertEqual(broadcasts.received(by: first), 1)
    XCTAssertEqual(broadcasts.received(by: second), 0)
    XCTAssertEqual(ThumbnailDecoder.cachedImage(forKey: firstBitmap)?.width, 16)
    XCTAssertEqual(ThumbnailDecoder.cachedImage(forKey: secondBitmap)?.width, 8)
  }

  func testAWarmingServerDoesNotHoldBackAnotherServersRefetch() async throws {
    let (warming, _, warmingShown) = await staleAsset(onServer: "https://a.example")
    let (held, _, _) = await staleAsset(onServer: "https://a.example")
    let (healthy, _, healthyShown) = await staleAsset(onServer: "https://b.example")
    let warmingKey = try XCTUnwrap(warmingShown.refreshKey)
    let healthyKey = try XCTUnwrap(healthyShown.refreshKey)
    let warmingSource = Source(token: "t2", answer: .serverNotReady)
    let healthySource = Source(token: "t2", answer: .bytes(newBytes))
    let finished = FinishedStaleRefreshes()
    let loader = await loader(finishing: finished)

    _ = await loader.load(for: warming, from: warmingSource)
    await waitUntil { finished.contains(warmingKey) }
    _ = await loader.load(for: held, from: warmingSource)
    _ = await loader.load(for: healthy, from: healthySource)
    await waitUntil { finished.contains(healthyKey) }

    let queued = await loader.pendingStaleRefetches.count
    let requestsToWarming = await warmingSource.requests
    XCTAssertEqual(queued, 1, "the warming server's refetch stays queued")
    XCTAssertEqual(requestsToWarming, 1)
  }

  func testTheSamePathOnTwoServersIsRefetchedOnEach() async throws {
    let (first, key, firstShown) = await staleAsset(onServer: "https://a.example")
    let second = AssetRef(
      displayName: "x.dng", hintExtension: "dng", stableID: key,
      thumbnailProvenance: .cloud(server: URL(string: "https://b.example")!),
      bytesProvider: { Data() })
    let firstKey = try XCTUnwrap(firstShown.refreshKey)
    let secondKey = try XCTUnwrap(ThumbnailSource.local(second, source: nil).refreshKey)
    let firstSource = Source(token: "t2", answer: .held)
    let secondSource = Source(token: "t2", answer: .held)
    let finished = FinishedStaleRefreshes()
    let loader = await loader(finishing: finished)

    _ = await loader.load(for: first, from: firstSource)
    _ = await loader.load(for: second, from: secondSource)
    await waitUntil { await firstSource.requests == 1 }
    await waitUntil { await secondSource.requests == 1 }
    await firstSource.release(with: newBytes)
    await secondSource.release(with: newBytes)
    await waitUntil { finished.contains(firstKey) }
    await waitUntil { finished.contains(secondKey) }
  }

  func testPendingRefetchesRunNewestFirstWithinABoundAndDroppedKeysAreRefetchedLater()
    async
  {
    let running = ThumbnailLoader.maxConcurrentStaleRefetches
    let pending = ThumbnailLoader.maxPendingStaleRefetches
    let dropped = 2
    var assets: [(asset: AssetRef, key: String, source: ThumbnailSource)] = []
    for _ in 0..<(running + pending + dropped) { assets.append(await staleAsset()) }
    let source = Source(token: "t2", answer: .held)
    let finished = FinishedStaleRefreshes()
    let loader = await loader(finishing: finished)

    for entry in assets { _ = await loader.load(for: entry.asset, from: source) }
    await waitUntil { await source.requests == running }
    let firstWave = await source.requestedIDs
    XCTAssertEqual(Set(firstWave), Set(assets.prefix(running).map(\.key)))

    await source.release(with: newBytes)
    await waitUntil { finished.count == running + pending }

    let order = await source.requestedIDs
    let peak = await source.peakInFlight
    let droppedKeys = assets[running..<(running + dropped)].map(\.key)
    XCTAssertEqual(order[running], assets.last?.key, "the newest key runs first")
    XCTAssertTrue(Set(order).isDisjoint(with: droppedKeys), "the oldest waiting keys are dropped")
    XCTAssertLessThanOrEqual(peak, running)

    let again = assets[running]
    _ = await loader.load(for: again.asset, from: source)
    await waitUntil { finished.contains(again.key) }
    let requestsForDropped = await source.requestedIDs.filter { $0 == again.key }.count
    XCTAssertEqual(requestsForDropped, 1, "a dropped key is refetched when shown again")

    _ = await loader.load(for: assets[0].asset, from: source)
    let requestsForRan = await source.requestedIDs.filter { $0 == assets[0].key }.count
    XCTAssertEqual(requestsForRan, 1, "a key that ran is not refetched in the launch")
  }
}

final class FinishedStaleRefreshes: @unchecked Sendable {
  private let lock = NSLock()
  private var keys: [String] = []

  func record(_ key: String) { lock.withLock { keys.append(key) } }
  func contains(_ key: String) -> Bool { lock.withLock { keys.contains(key) } }
  var count: Int { lock.withLock { keys.count } }
}

extension ThumbnailLoader {
  func setStaleRefreshDidFinish(_ hook: @escaping @Sendable (String) -> Void) {
    staleRefreshDidFinish = hook
  }
}
