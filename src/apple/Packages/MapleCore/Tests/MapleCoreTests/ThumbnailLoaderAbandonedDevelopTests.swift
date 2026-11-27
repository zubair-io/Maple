import XCTest

@testable import MapleCore

final class ThumbnailLoaderAbandonedDevelopTests: XCTestCase {
  private actor Latch {
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var isOpen = false
    private(set) var arrivals = 0

    func wait() async {
      arrivals += 1
      guard !isOpen else { return }
      await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
      isOpen = true
      for waiter in waiters { waiter.resume() }
      waiters = []
    }
  }

  private final class DevelopCount: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    private var joinableAtGiveUp: Bool?
    var value: Int { lock.withLock { count } }
    var wasJoinableWhenItGaveUp: Bool? { lock.withLock { joinableAtGiveUp } }
    func record() { lock.withLock { count += 1 } }
    func recordGiveUp(joinable: Bool) { lock.withLock { joinableAtGiveUp = joinable } }
  }

  private let timeout: Duration = .seconds(15)
  private let producerKey = "develop-after-decode"

  private func eventually(_ message: String, condition: @Sendable () async -> Bool) async {
    let held = await waitForCondition(timeout: timeout, condition: condition)
    XCTAssertTrue(held, message)
  }

  private func producerThatDevelopsAfter(
    _ latch: Latch, loader: ThumbnailLoader, develops: DevelopCount
  ) async -> Task<Data?, Never> {
    await loader.startLocalProducer(key: producerKey) { [producerKey] in
      await latch.wait()
      do {
        _ = try await loader.developOffSlot(priority: .standard) { develops.record() }
        return Data([1])
      } catch {
        develops.recordGiveUp(joinable: await loader.inFlight[producerKey] != nil)
        return nil
      }
    }
  }

  private func waiterCount(_ loader: ThumbnailLoader, _ task: Task<Data?, Never>) async -> Int {
    await loader.thumbnailWaiters[task]?.count ?? 0
  }

  // One acquirer more than capacity: a leaked slot leaves two queued, which times out instead of hanging.
  private func assertDecodeSlotsBalanced(_ loader: ThumbnailLoader) async {
    let slots = await loader.decodeSlots
    let acquirers = (0...ThumbnailLoader.maxConcurrentDecodes).map { _ in
      Task { () -> Bool in (try? await slots.acquire()) != nil }
    }
    await eventually("every decode slot came back and none is extra") {
      await slots.queuedCount == 1
    }
    for acquirer in acquirers { acquirer.cancel() }
    for acquirer in acquirers {
      if await acquirer.value { await slots.release() }
    }
  }

  func testConsumerLeavingBeforeTheDevelopSkipsTheDevelop() async throws {
    let loader = ThumbnailLoader()
    let latch = Latch()
    let develops = DevelopCount()
    let producer = await producerThatDevelopsAfter(latch, loader: loader, develops: develops)
    let consumer = Task { await loader.awaitThumbnail(producer) }
    await eventually("the producer is active and has its consumer") {
      let joined = await self.waiterCount(loader, producer) == 1
      let arrived = await latch.arrivals == 1
      return joined && arrived
    }

    consumer.cancel()
    await eventually("the consumer leaves") { await self.waiterCount(loader, producer) == 0 }
    await eventually("the producer is marked as unwanted") {
      await loader.abandonedProducers.count == 1
    }
    XCTAssertFalse(producer.isCancelled, "an active producer is not cancelled by its consumer")
    await latch.open()

    let result = await producer.value
    XCTAssertNil(result)
    XCTAssertEqual(develops.value, 0, "nobody wants this develop any more")
    XCTAssertEqual(
      develops.wasJoinableWhenItGaveUp, false, "a tile scrolling back must start a new producer")
    let abandoned = await loader.abandonedProducers
    XCTAssertTrue(abandoned.isEmpty)
    await assertDecodeSlotsBalanced(loader)
  }

  func testAVanishedSidecarTakesTheDecodeSlotBackForTheEmbeddedPreview() async throws {
    let loader = ThumbnailLoader()
    let raw = FileManager.default.temporaryDirectory
      .appendingPathComponent("vanished-sidecar-\(UUID().uuidString).dng")
    let producer = await loader.startLocalProducer(key: "vanished-sidecar") {
      let data = try? await loader.developRawSidecar(at: raw, targetLongEdge: 64, quality: 0.5)
      guard data == nil, let id = ThumbnailLoader.producerID else { return nil }
      let holdsSlot = await !loader.slotlessProducers.contains(id)
      return holdsSlot ? Data([1]) : nil
    }

    let result = await producer.value
    XCTAssertEqual(result, Data([1]), "the embedded-preview read runs holding a decode slot")
    await assertDecodeSlotsBalanced(loader)
  }

  func testConsumerJoiningAgainBeforeTheDevelopKeepsIt() async throws {
    let loader = ThumbnailLoader()
    let latch = Latch()
    let develops = DevelopCount()
    let producer = await producerThatDevelopsAfter(latch, loader: loader, develops: develops)
    let first = Task { await loader.awaitThumbnail(producer) }
    await eventually("the producer is active and has its consumer") {
      let joined = await self.waiterCount(loader, producer) == 1
      let arrived = await latch.arrivals == 1
      return joined && arrived
    }
    first.cancel()
    await eventually("the first consumer leaves") { await self.waiterCount(loader, producer) == 0 }
    await eventually("the producer is marked as unwanted") {
      await loader.abandonedProducers.count == 1
    }

    let second = Task { await loader.awaitThumbnail(producer) }
    await eventually("a tile scrolled back joins the same producer") {
      await self.waiterCount(loader, producer) == 1
    }
    await latch.open()

    let result = await second.value
    XCTAssertEqual(result, Data([1]))
    XCTAssertEqual(develops.value, 1)
  }
}
