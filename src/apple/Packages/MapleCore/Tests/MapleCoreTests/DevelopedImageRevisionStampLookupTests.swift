// A fast scroll cancels most grid cells before their source-stamp lookup
// starts; those cells must not still stat the file (#6019).

import XCTest

@testable import MapleCore

@MainActor
final class DevelopedImageRevisionStampLookupTests: XCTestCase {
  private actor StampLatch {
    static let stamp = "source-v1|latched"

    private(set) var callCount = 0
    private(set) var started: [String] = []
    private var isOpen = false
    private var blocked: [CheckedContinuation<Void, Never>] = []

    func stamp(_ url: URL, label: String = "") async -> String? {
      callCount += 1
      started.append(label)
      if !isOpen {
        await withCheckedContinuation { blocked.append($0) }
      }
      return Self.stamp
    }

    func finishOne() {
      guard !blocked.isEmpty else { return }
      blocked.removeFirst().resume()
    }

    func open() {
      isOpen = true
      for continuation in blocked { continuation.resume() }
      blocked.removeAll()
    }
  }

  private actor PriorityBox {
    private(set) var priority: TaskPriority?
    func record(_ seen: TaskPriority) { priority = seen }
  }

  private func makeAsset() throws -> (folder: URL, asset: URL) {
    let folder = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-stamp-lookup-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let asset = folder.appendingPathComponent("photo.jpg")
    try Data([0x01]).write(to: asset)
    return (folder, asset)
  }

  func testCancelledCallsSkipTheirQueuedStampLookup() async throws {
    let (folder, assetURL) = try makeAsset()
    defer { try? FileManager.default.removeItem(at: folder) }
    let source = ThumbnailSource.local(AssetRef(url: assetURL), source: nil)
    let revisions = DevelopedImageRevision()
    let latch = StampLatch()
    let callCount = 1_000
    let survivorCount = 10
    let width = DevelopedImageRevision.sourceStampLookupWidth

    let calls = (0..<callCount).map { _ in
      Task {
        await revisions.decodedKeyAsync(for: "photo", source: source) { url in
          await latch.stamp(url)
        }
      }
    }
    let othersQueued = await DevelopedImageRevision.sourceStampSlots.waitForQueue(
      atLeast: callCount - width, timeout: .seconds(20))
    XCTAssertTrue(othersQueued, "every call beyond the limiter width must be queued")
    let slotsBusy = await waitForCondition(timeout: .seconds(10)) {
      await latch.callCount >= width
    }
    XCTAssertTrue(slotsBusy, "the limiter width of lookups must be in flight")

    for call in calls.dropFirst(survivorCount) { call.cancel() }
    await latch.open()
    var keys: [String] = []
    for call in calls { keys.append(await call.value) }

    let stampCalls = await latch.callCount
    print(
      "[#6019] stamp lookups for \(callCount) calls with "
        + "\(callCount - survivorCount) cancelled: \(stampCalls)")
    XCTAssertLessThanOrEqual(stampCalls, width + survivorCount)
    XCTAssertGreaterThanOrEqual(stampCalls, survivorCount)

    let base = revisions.reloadKey(for: "photo", source: source)
    let stamped = "\(base):source:\(MapleThumbCacheKey.sha256Prefix16(StampLatch.stamp))"
    XCTAssertEqual(
      Array(keys.prefix(survivorCount)), Array(repeating: stamped, count: survivorCount))
    XCTAssertTrue(keys.allSatisfy { $0 == base || $0 == stamped })
    XCTAssertEqual(keys.filter { $0 == stamped }.count, stampCalls)
    let queuedAtEnd = await DevelopedImageRevision.sourceStampSlots.queuedCount
    XCTAssertEqual(queuedAtEnd, 0)
  }

  func testTheOpenedPhotosLookupIsServedBeforeQueuedGridLookups() async throws {
    let (folder, assetURL) = try makeAsset()
    defer { try? FileManager.default.removeItem(at: folder) }
    let source = ThumbnailSource.local(AssetRef(url: assetURL), source: nil)
    let revisions = DevelopedImageRevision()
    let latch = StampLatch()
    let width = DevelopedImageRevision.sourceStampLookupWidth
    let queuedGridCount = 20
    func lookup(
      _ label: String, _ priority: BoundedAsyncSemaphore.Priority
    ) -> Task<String, Never> {
      Task {
        await revisions.decodedKeyAsync(for: "photo", source: source, priority: priority) {
          await latch.stamp($0, label: label)
        }
      }
    }

    let running = (0..<width).map { _ in lookup("running", .standard) }
    let slotsBusy = await waitForCondition(timeout: .seconds(20)) {
      await latch.callCount == width
    }
    XCTAssertTrue(slotsBusy, "precondition: every slot holds a lookup")
    let grid = (0..<queuedGridCount).map { _ in lookup("grid", .standard) }
    let gridQueued = await DevelopedImageRevision.sourceStampSlots.waitForQueue(
      atLeast: queuedGridCount, timeout: .seconds(20))
    XCTAssertTrue(gridQueued, "precondition: the grid's lookups are waiting")
    let opened = lookup("opened", .interactive)
    let openedQueued = await DevelopedImageRevision.sourceStampSlots.waitForQueue(
      atLeast: queuedGridCount + 1, timeout: .seconds(20))
    XCTAssertTrue(openedQueued, "precondition: the opened photo's lookup is waiting too")

    await latch.finishOne()
    let nextStarted = await waitForCondition(timeout: .seconds(20)) {
      await latch.callCount == width + 1
    }
    XCTAssertTrue(nextStarted)
    let next = await latch.started.last
    XCTAssertEqual(next, "opened", "the freed slot goes to the opened photo, not the oldest cell")

    await latch.open()
    for task in running + grid + [opened] { _ = await task.value }
    let queuedAtEnd = await DevelopedImageRevision.sourceStampSlots.queuedCount
    XCTAssertEqual(queuedAtEnd, 0)
  }

  func testLookupRunsAtUserInitiatedPriorityFromALowPriorityCaller() async throws {
    let (folder, assetURL) = try makeAsset()
    defer { try? FileManager.default.removeItem(at: folder) }
    let source = ThumbnailSource.local(AssetRef(url: assetURL), source: nil)
    let revisions = DevelopedImageRevision()
    let latch = StampLatch()
    await latch.open()

    let lookupPriority = await Task.detached(priority: .utility) {
      let seen = PriorityBox()
      _ = await revisions.decodedKeyAsync(for: "photo", source: source) { url in
        // The base priority is the one the lookup was started with; the
        // current one is raised to the awaiting test's and would pass anyway.
        await seen.record(Task.basePriority ?? .background)
        return await latch.stamp(url)
      }
      return await seen.priority
    }.value

    let priority = try XCTUnwrap(lookupPriority)
    XCTAssertGreaterThanOrEqual(
      priority.rawValue, TaskPriority.userInitiated.rawValue,
      "a visible cell waits on this lookup")
  }

  func testUncancelledLookupKeepsTheStampedKey() async throws {
    let (folder, assetURL) = try makeAsset()
    defer { try? FileManager.default.removeItem(at: folder) }
    try Data("<xmp>crop</xmp>".utf8).write(to: SidecarPath.sidecarURL(for: assetURL))
    let source = ThumbnailSource.local(AssetRef(url: assetURL), source: nil)
    let revisions = DevelopedImageRevision()
    let base = revisions.reloadKey(for: "photo", source: source)
    let previousImplementationKey =
      "\(base):source:"
      + MapleThumbCacheKey.sha256Prefix16(LocalDerivativeSourceStamp.signature(for: assetURL))

    let key = await revisions.decodedKeyAsync(for: "photo", source: source)

    XCTAssertEqual(key, previousImplementationKey)
    XCTAssertEqual(key, revisions.decodedKey(for: "photo", source: source))

    let missing = ThumbnailSource.local(
      AssetRef(url: folder.appendingPathComponent("missing.jpg")), source: nil)
    let missingKey = await revisions.decodedKeyAsync(for: "missing", source: missing)
    XCTAssertEqual(missingKey, revisions.reloadKey(for: "missing", source: missing))
  }
}
