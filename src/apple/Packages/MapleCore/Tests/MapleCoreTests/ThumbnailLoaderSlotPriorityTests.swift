// The opened photo's display preview must not wait behind a grid's queued
// thumbnail producers for a decode slot (#6019). Stub grid producers only:
// no decoding, no fixtures.

import XCTest

@testable import MapleCore

final class ThumbnailLoaderSlotPriorityTests: XCTestCase {
  private static let gridProducerCount = 60

  private actor StartOrder {
    private(set) var labels: [String] = []

    func record(_ label: String) {
      labels.append(label)
    }
  }

  /// Parks every started grid producer so the one circulating decode slot
  /// stays with whichever producer the semaphore handed it to.
  private actor Latch {
    private var isOpen = false
    private var parked: [CheckedContinuation<Void, Never>] = []

    func wait() async {
      guard !isOpen else { return }
      await withCheckedContinuation { parked.append($0) }
    }

    func open() {
      isOpen = true
      for continuation in parked { continuation.resume() }
      parked.removeAll()
    }
  }

  func testInteractiveLaneStartsAheadOfQueuedGridProducers() async throws {
    let standardLane = try await gridProducersStartedBeforePreview(previewSlotPriority: .standard)
    let interactiveLane = try await gridProducersStartedBeforePreview(
      previewSlotPriority: .interactive)
    print(
      "[#6019] grid producers started before the display preview: "
        + "standard lane \(standardLane), interactive lane \(interactiveLane)")
    XCTAssertEqual(standardLane, Self.gridProducerCount)
    XCTAssertEqual(interactiveLane, 0)
  }

  /// Goes through `loadDisplayPreview` itself, so it fails if that entry
  /// point stops queueing its producer ahead of the grid. The preview is a
  /// cold, undecodable temp file: only its slot order matters here.
  func testLoadDisplayPreviewTakesTheNextFreedSlotAheadOfQueuedGridProducers() async throws {
    let folder = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-slot-priority-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let previewURL = folder.appendingPathComponent("opened.jpg")
    try Data([0x00, 0x01, 0x02, 0x03]).write(to: previewURL)

    let loader = ThumbnailLoader()
    let starts = StartOrder()
    let latch = Latch()
    let slotCount = ThumbnailLoader.maxConcurrentDecodes
    for _ in 0..<slotCount {
      try await loader.acquireDecodeSlot()
    }

    var gridProducers: [Task<Data?, Never>] = []
    for index in 0..<Self.gridProducerCount {
      gridProducers.append(
        await loader.startLocalProducer(key: "grid-\(index)") {
          await starts.record("grid-\(index)")
          await latch.wait()
          return nil
        })
    }
    let gridQueued = await loader.decodeSlots.waitForQueue(atLeast: Self.gridProducerCount)
    XCTAssertTrue(gridQueued)

    let preview = Task { await loader.loadDisplayPreview(for: AssetRef(url: previewURL)) }
    let previewQueued = await loader.decodeSlots.waitForQueue(
      atLeast: Self.gridProducerCount + 1)
    XCTAssertTrue(previewQueued, "the cold display preview must queue for a decode slot")

    // Exactly one slot circulates: the first grid producer to start parks on
    // it. If the preview was served first it has already left the queue.
    await loader.releaseDecodeSlot()
    let firstGridStarted = await waitForCondition(timeout: .seconds(10)) {
      await starts.labels.count >= 1
    }
    XCTAssertTrue(firstGridStarted)
    let queuedWhenFirstGridStarted = await loader.decodeSlots.queuedCount
    let previewServedFirst = queuedWhenFirstGridStarted == Self.gridProducerCount - 1
    print(
      "[#6019] loadDisplayPreview served before the first grid producer: \(previewServedFirst) "
        + "(\(queuedWhenFirstGridStarted) producers still queued)")
    XCTAssertTrue(
      previewServedFirst,
      "loadDisplayPreview must take the freed slot before any queued grid producer")

    await latch.open()
    for _ in 1..<slotCount { await loader.releaseDecodeSlot() }
    _ = await preview.value
    for producer in gridProducers { _ = await producer.value }
  }

  /// Holds every decode slot, queues the grid producers and then the
  /// preview, and lets a single slot circulate so start order is exactly
  /// the semaphore's hand-off order. A standard-lane preview reproduces the
  /// former first-come-first-served queue.
  private func gridProducersStartedBeforePreview(
    previewSlotPriority: BoundedAsyncSemaphore.Priority
  ) async throws -> Int {
    let loader = ThumbnailLoader()
    let starts = StartOrder()
    let slotCount = ThumbnailLoader.maxConcurrentDecodes
    for _ in 0..<slotCount {
      try await loader.acquireDecodeSlot()
    }

    var gridProducers: [Task<Data?, Never>] = []
    for index in 0..<Self.gridProducerCount {
      gridProducers.append(
        await loader.startLocalProducer(key: "grid-\(index)") {
          await starts.record("grid-\(index)")
          return nil
        })
    }
    let gridQueued = await loader.decodeSlots.waitForQueue(atLeast: Self.gridProducerCount)
    XCTAssertTrue(gridQueued)

    let preview = await loader.startLocalProducer(
      key: "display-preview:opened", slotPriority: previewSlotPriority
    ) {
      await starts.record("preview")
      return nil
    }
    let previewQueued = await loader.decodeSlots.waitForQueue(
      atLeast: Self.gridProducerCount + 1)
    XCTAssertTrue(previewQueued)

    await loader.releaseDecodeSlot()
    _ = await preview.value
    for producer in gridProducers { _ = await producer.value }
    for _ in 1..<slotCount { await loader.releaseDecodeSlot() }

    let labels = await starts.labels
    XCTAssertEqual(labels.count, Self.gridProducerCount + 1)
    return labels.firstIndex(of: "preview") ?? labels.count
  }
}
