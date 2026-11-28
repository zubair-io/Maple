// StaleCloudThumbnailRefreshTests — #6175: a cached cloud thumbnail whose
// server token is out of date is shown at once and refetched once per launch,
// and the new bytes reach the cell that is still showing that photo.

import XCTest

@testable import MapleCore

func waitUntil(timeout: Duration = .seconds(5), _ condition: () async -> Bool) async {
  let deadline = ContinuousClock.now + timeout
  while ContinuousClock.now < deadline {
    if await condition() { return }
    try? await Task.sleep(for: .milliseconds(5))
  }
}

extension ThumbnailLoader {
  func staleRefreshFinished(forKey key: String) -> Bool {
    staleRefreshedKeys.contains(key) && staleRefreshObservers[key] == nil
  }
}

final class StaleCloudThumbnailRefreshTests: XCTestCase {
  private enum Answer {
    case bytes(Data)
    case serverNotReady
    case held
  }

  private actor Source: ImageSource {
    private(set) var requests = 0
    private var answer: Answer
    private var heldRequests: [CheckedContinuation<Void, Never>] = []
    private let token: String

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
      requests += 1
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

  private actor Updates {
    private(set) var received: [Data] = []
    func record(_ bytes: Data) { received.append(bytes) }
  }

  private let oldBytes = Data("old".utf8)
  private let newBytes = Data("new".utf8)
  private var keys: [String] = []

  override func tearDown() async throws {
    for key in keys {
      removeSourcelessThumbCacheFile(forKey: key)
      try? FileManager.default.removeItem(
        at: sourcelessThumbCacheFileURL(forKey: key).appendingPathExtension("source"))
    }
    keys = []
  }

  private func staleAsset() async -> (asset: AssetRef, key: String) {
    let key = "fs:/srv/photos/\(UUID().uuidString).dng"
    keys.append(key)
    await ThumbnailDiskCache.shared.storeThumbnailData(oldBytes, forKey: key, token: "t1")
    let asset = AssetRef(
      displayName: "x.dng", hintExtension: "dng", stableID: key, bytesProvider: { Data() })
    return (asset, key)
  }

  func testStaleThumbnailIsShownWhileTheServerIsNotReadyAndIsNotAskedAgain() async {
    let (asset, key) = await staleAsset()
    let source = Source(token: "t2", answer: .serverNotReady)
    let loader = ThumbnailLoader()

    let first = await loader.load(for: asset, from: source)
    await waitUntil { await loader.staleRefreshFinished(forKey: key) }
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

  func testStaleThumbnailIsShownWhileASlowRequestIsPendingThenTheCellGetsTheNewBytes() async {
    let (asset, key) = await staleAsset()
    let source = Source(token: "t2", answer: .held)
    let loader = ThumbnailLoader()
    let updates = Updates()

    let shown = await loader.load(for: asset, from: source) { await updates.record($0) }
    await waitUntil { await source.requests == 1 }
    let beforeAnswer = await updates.received
    XCTAssertEqual(shown, oldBytes)
    XCTAssertEqual(beforeAnswer, [])

    await source.release(with: newBytes)
    await waitUntil { await !updates.received.isEmpty }

    let received = await updates.received
    let current = await ThumbnailDiskCache.shared.thumbnailData(forKey: key, currentToken: "t2")
    XCTAssertEqual(received, [newBytes])
    XCTAssertEqual(current, newBytes)
  }

  func testIdenticalBytesStoreTheTokenWithoutUpdatingTheCell() async {
    let (asset, key) = await staleAsset()
    let source = Source(token: "t2", answer: .bytes(oldBytes))
    let loader = ThumbnailLoader()
    let updates = Updates()

    _ = await loader.load(for: asset, from: source) { await updates.record($0) }
    await waitUntil { await loader.staleRefreshFinished(forKey: key) }
    try? await Task.sleep(for: .milliseconds(50))

    let received = await updates.received
    let current = await ThumbnailDiskCache.shared.thumbnailData(forKey: key, currentToken: "t2")
    XCTAssertEqual(received, [])
    XCTAssertEqual(current, oldBytes)
  }

  func testSeveralLoadsOfOneStaleKeyShareOneRefetchAndEveryCellHearsOfIt() async {
    let (asset, key) = await staleAsset()
    let source = Source(token: "t2", answer: .held)
    let loader = ThumbnailLoader()
    let first = Updates()
    let second = Updates()

    _ = await loader.load(for: asset, from: source) { await first.record($0) }
    _ = await loader.load(for: asset, from: source) { await second.record($0) }
    _ = await loader.load(for: asset, from: source)
    await source.release(with: newBytes)
    await waitUntil { await loader.staleRefreshFinished(forKey: key) }
    _ = await loader.load(for: asset, from: source)

    let requests = await source.requests
    let firstReceived = await first.received
    let secondReceived = await second.received
    XCTAssertEqual(requests, 1)
    XCTAssertEqual(firstReceived, [newBytes])
    XCTAssertEqual(secondReceived, [newBytes])
  }

  @MainActor
  func testReusedCellIgnoresALateThumbnailForItsPreviousPhoto() async {
    let (asset, key) = await staleAsset()
    let source = Source(token: "t2", answer: .held)
    let loader = ThumbnailLoader()
    let cell = ThumbnailCellTarget()
    let displayed = Updates()

    cell.show(key)
    _ = await loader.load(for: asset, from: source) { [cell] bytes in
      if cell.isShowing(key) { await displayed.record(bytes) }
    }
    cell.show("another-photo")
    await source.release(with: newBytes)
    await waitUntil { await loader.staleRefreshFinished(forKey: key) }

    let received = await displayed.received
    XCTAssertEqual(received, [])
  }

  @MainActor
  func testCellStillShowingThePhotoReceivesTheLateThumbnail() async {
    let (asset, key) = await staleAsset()
    let source = Source(token: "t2", answer: .held)
    let loader = ThumbnailLoader()
    let cell = ThumbnailCellTarget()
    let displayed = Updates()

    cell.show(key)
    _ = await loader.load(for: asset, from: source) { [cell] bytes in
      if cell.isShowing(key) { await displayed.record(bytes) }
    }
    await source.release(with: newBytes)
    await waitUntil { await !displayed.received.isEmpty }

    let received = await displayed.received
    XCTAssertEqual(received, [newBytes])
  }
}
