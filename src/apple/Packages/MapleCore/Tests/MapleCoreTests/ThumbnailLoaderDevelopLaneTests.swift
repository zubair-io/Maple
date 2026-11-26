import XCTest

@testable import MapleCore

final class ThumbnailLoaderDevelopLaneTests: XCTestCase {
  private final class DevelopProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var gates: [String: DispatchSemaphore] = [:]
    private var started: [String] = []
    private var running = 0
    private(set) var maxRunning = 0

    var startedLabels: [String] { locked { started } }
    var runningCount: Int { locked { running } }

    private func locked<T>(_ body: () -> T) -> T {
      lock.lock()
      defer { lock.unlock() }
      return body()
    }

    func develop(_ label: String) -> @Sendable () throws -> Int {
      let gate = DispatchSemaphore(value: 0)
      locked { gates[label] = gate }
      return { [self] in
        locked {
          started.append(label)
          running += 1
          maxRunning = max(maxRunning, running)
        }
        gate.wait()
        locked { running -= 1 }
        return 1
      }
    }

    func release(_ label: String) {
      locked { gates[label] }?.signal()
    }

    func releaseAll() {
      for gate in locked({ Array(gates.values) }) { gate.signal() }
    }
  }

  private actor Counter {
    private(set) var value = 0
    func increment() { value += 1 }
  }

  private struct DevelopFailure: Error {}

  private let timeout: Duration = .seconds(15)

  private func eventually(
    _ message: String, condition: @Sendable () async -> Bool
  ) async {
    let held = await waitForCondition(timeout: timeout, condition: condition)
    XCTAssertTrue(held, message)
  }

  private func finish(_ tasks: [Task<Data?, Never>], _ message: String) async {
    let done = Counter()
    for task in tasks {
      Task {
        _ = await task.value
        await done.increment()
      }
    }
    await eventually(message) { await done.value == tasks.count }
  }

  private func producer(
    _ loader: ThumbnailLoader, label: String, probe: DevelopProbe,
    priority: BoundedAsyncSemaphore.Priority = .standard
  ) async -> Task<Data?, Never> {
    let work = probe.develop(label)
    return await loader.startLocalProducer(key: "develop-\(label)", slotPriority: priority) {
      _ = try? await loader.developOffSlot(priority: priority, work)
      return nil
    }
  }

  private func gridProducers(
    _ loader: ThumbnailLoader, probe: DevelopProbe, count: Int
  ) async -> [Task<Data?, Never>] {
    var tasks: [Task<Data?, Never>] = []
    for index in 0..<count {
      tasks.append(await producer(loader, label: "grid-\(index)", probe: probe))
    }
    let lane = await loader.gridDevelopLane
    await eventually("one grid develop runs and the rest queue") {
      guard probe.runningCount == 1 else { return false }
      return (await lane.queuedCount) == count - 1
    }
    return tasks
  }

  private func assertPermitsBalanced(_ loader: ThumbnailLoader) async {
    let semaphores = [
      ("decode slots", await loader.decodeSlots, ThumbnailLoader.maxConcurrentDecodes),
      ("grid lane", await loader.gridDevelopLane, 1),
      ("interactive lane", await loader.interactiveDevelopLane, 1),
    ]
    for (name, semaphore, capacity) in semaphores {
      let held = Counter()
      let fillers = (0..<capacity).map { _ in
        Task {
          try await semaphore.acquire()
          await held.increment()
        }
      }
      await eventually("\(name): fewer permits than capacity, one leaked") {
        await held.value == capacity
      }
      let extra = Task { try await semaphore.acquire() }
      await eventually("\(name): more permits than capacity") {
        await semaphore.queuedCount == 1
      }
      extra.cancel()
      for _ in 0..<capacity { await semaphore.release() }
      for filler in fillers { _ = try? await filler.value }
    }
  }

  func testCheapProducersCompleteWhileGridDevelopsAreQueued() async throws {
    let loader = ThumbnailLoader()
    let probe = DevelopProbe()
    let develops = await gridProducers(
      loader, probe: probe, count: ThumbnailLoader.maxConcurrentDecodes + 3)

    var cheap: [Task<Data?, Never>] = []
    for index in 0..<40 {
      cheap.append(await loader.startLocalProducer(key: "cheap-\(index)") { Data([UInt8(index)]) })
    }
    await finish(cheap, "cheap producers must not wait behind queued develops")
    XCTAssertEqual(probe.runningCount, 1)

    probe.releaseAll()
    await finish(develops, "develops finish once released")
    await assertPermitsBalanced(loader)
  }

  func testGridDevelopsRunOneAtATime() async throws {
    let loader = ThumbnailLoader()
    let probe = DevelopProbe()
    let count = 5
    let develops = await gridProducers(loader, probe: probe, count: count)
    var released: Set<String> = []
    for step in 0..<count {
      guard let next = probe.startedLabels.first(where: { !released.contains($0) }) else { break }
      released.insert(next)
      probe.release(next)
      await eventually("the next queued develop starts") {
        probe.startedLabels.count >= min(count, step + 2)
      }
    }
    await finish(develops, "develops finish once released")
    XCTAssertEqual(probe.startedLabels.count, count)
    XCTAssertEqual(probe.maxRunning, 1)
  }

  func testInteractiveDevelopStartsAtOnceWhileGridDevelopsAreBusyAndQueued() async throws {
    let loader = ThumbnailLoader()
    let probe = DevelopProbe()
    var develops = await gridProducers(loader, probe: probe, count: 4)
    develops.append(await producer(loader, label: "open-1", probe: probe, priority: .interactive))
    develops.append(await producer(loader, label: "open-2", probe: probe, priority: .interactive))

    let isOpening = { (label: String) in label.hasPrefix("open") }
    await eventually("an interactive develop starts beside the busy grid develop") {
      probe.runningCount == 2 && probe.startedLabels.contains(where: isOpening)
    }
    let interactive = await loader.interactiveDevelopLane
    await eventually("the other interactive develop queues behind it, not behind grid work") {
      (await interactive.queuedCount) == 1
    }
    let first = try XCTUnwrap(probe.startedLabels.first(where: isOpening))
    XCTAssertEqual(probe.startedLabels.filter { $0.hasPrefix("grid") }.count, 1)

    probe.release(first)
    await eventually("the other interactive develop takes over the reserved permit") {
      probe.startedLabels.filter(isOpening).count == 2
    }
    XCTAssertEqual(probe.startedLabels.filter { $0.hasPrefix("grid") }.count, 1)
    XCTAssertEqual(probe.maxRunning, 2)

    probe.releaseAll()
    await finish(develops, "develops finish once released")
    await assertPermitsBalanced(loader)
  }

  func testGridDevelopNeverTakesTheReservedInteractivePermit() async throws {
    let loader = ThumbnailLoader()
    let probe = DevelopProbe()
    let develops = await gridProducers(loader, probe: probe, count: 3)
    let interactive = await loader.interactiveDevelopLane
    let reservedFree = Counter()
    let taker = Task {
      try await interactive.acquire()
      await reservedFree.increment()
    }
    await eventually("the reserved permit is still free while grid work is queued") {
      await reservedFree.value == 1
    }
    await interactive.release()
    _ = try await taker.value
    XCTAssertEqual(probe.startedLabels.count, 1)

    probe.releaseAll()
    await finish(develops, "develops finish once released")
    await assertPermitsBalanced(loader)
  }

  func testCancelWhileQueuedInLaneRunsNoDevelopAndHoldsNoPermit() async throws {
    let loader = ThumbnailLoader()
    let probe = DevelopProbe()
    var develops = await gridProducers(loader, probe: probe, count: 1)
    let doomed = await producer(loader, label: "doomed", probe: probe)
    develops.append(doomed)
    let lane = await loader.gridDevelopLane
    await eventually("the develop queues in the lane") { (await lane.queuedCount) == 1 }

    doomed.cancel()
    await eventually("a cancelled develop leaves the queue") { (await lane.queuedCount) == 0 }

    probe.releaseAll()
    await finish(develops, "develops finish once released")
    XCTAssertFalse(probe.startedLabels.contains("doomed"))
    await assertPermitsBalanced(loader)
  }

  func testLastConsumerLeavingCancelsAProducerQueuedInLane() async throws {
    let loader = ThumbnailLoader()
    let probe = DevelopProbe()
    var develops = await gridProducers(loader, probe: probe, count: 1)
    let doomed = await producer(loader, label: "scrolled-away", probe: probe)
    develops.append(doomed)
    let consumer = Task { await loader.awaitThumbnail(doomed) }
    let lane = await loader.gridDevelopLane
    await eventually("the develop queues in the lane") { (await lane.queuedCount) == 1 }

    consumer.cancel()
    await eventually("a tile scrolled away must leave the develop queue") {
      (await lane.queuedCount) == 0
    }

    probe.releaseAll()
    await finish(develops, "develops finish once released")
    XCTAssertFalse(probe.startedLabels.contains("scrolled-away"))
    await assertPermitsBalanced(loader)
  }

  func testRunningDevelopSurvivesItsConsumerLeaving() async throws {
    let loader = ThumbnailLoader()
    let probe = DevelopProbe()
    let running = await producer(loader, label: "running", probe: probe)
    let consumer = Task { await loader.awaitThumbnail(running) }
    await eventually("the develop starts") { probe.runningCount == 1 }

    consumer.cancel()
    await eventually("the consumer leaves") { (await loader.thumbnailWaiters[running]) == nil }
    XCTAssertFalse(running.isCancelled, "a develop already running finishes as it does today")
    probe.releaseAll()
    await finish([running], "the running develop finishes")
    XCTAssertEqual(probe.startedLabels, ["running"])
    await assertPermitsBalanced(loader)
  }

  func testPermitsBalanceAfterAThrowingDevelop() async throws {
    let loader = ThumbnailLoader()
    let failing = await loader.startLocalProducer(key: "failing") {
      do {
        _ = try await loader.developOffSlot(priority: .standard) { throw DevelopFailure() }
        return Data([1])
      } catch is DevelopFailure {
        return Data([2])
      } catch {
        return nil
      }
    }
    await finish([failing], "a throwing develop finishes")
    let result = await failing.value
    XCTAssertEqual(result, Data([2]), "the develop's own error must reach the caller")
    await assertPermitsBalanced(loader)
  }

  func testFinishedDevelopDeliversWithoutWaitingForADecodeSlot() async throws {
    let loader = ThumbnailLoader()
    let probe = DevelopProbe()
    let develop = await producer(loader, label: "solo", probe: probe)
    await eventually("the develop starts") { probe.runningCount == 1 }

    let slots = ThumbnailLoader.maxConcurrentDecodes
    let held = Counter()
    let fillers = (0..<slots).map { _ in
      Task {
        try await loader.acquireDecodeSlot()
        await held.increment()
      }
    }
    await eventually("a running develop holds no decode slot") { await held.value == slots }
    let waiting = Task { try await loader.acquireDecodeSlot() }
    await eventually("a cheap producer waits for a slot") {
      (await loader.decodeSlots.queuedCount) == 1
    }

    probe.releaseAll()
    await finish([develop], "a finished develop must not queue for a decode slot")
    for _ in 0..<(await held.value) { await loader.releaseDecodeSlot() }
    for filler in fillers { filler.cancel() }
    _ = try? await waiting.value
    await loader.releaseDecodeSlot()
    await assertPermitsBalanced(loader)
  }

  private var root: URL!
  private var raw: URL!

  private func stageRaw(name: String = "photo") throws {
    root = FileManager.default.temporaryDirectory
      .appendingPathComponent("develop-lane-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    raw = root.appendingPathComponent("\(name).dng")
    try FileManager.default.copyItem(
      at: try XCTUnwrap(fixture("test-fixtures/batch-transfer/source.dng")), to: raw)
  }

  private func fixture(_ relativePath: String) -> URL? {
    var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    while directory.path != "/" {
      let candidate = directory.appendingPathComponent(relativePath)
      if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
      directory.deleteLastPathComponent()
    }
    return nil
  }

  private func holdBothLanes(
    _ loader: ThumbnailLoader, probe: DevelopProbe
  ) async -> [Task<Int, Error>] {
    let grid = Task {
      try await loader.developOffSlot(priority: .standard, probe.develop("held-grid"))
    }
    let open = Task {
      try await loader.developOffSlot(priority: .interactive, probe.develop("held-open"))
    }
    await eventually("both lanes are held") { probe.runningCount == 2 }
    return [grid, open]
  }

  func testUneditedRawIsNotADevelopAndIgnoresAFullLane() async throws {
    try stageRaw()
    defer { try? FileManager.default.removeItem(at: root) }
    await ThumbnailDiskCache.shared.configure(folderURL: root)
    let loader = ThumbnailLoader()
    let probe = DevelopProbe()
    let held = await holdBothLanes(loader, probe: probe)
    let queuedBefore = await loader.gridDevelopLane.queuedCount

    let url = raw!
    let preview = Task { await loader.loadDisplayPreview(for: AssetRef(url: url)) }
    await finish([preview], "an unedited RAW's display preview must not wait for the develop lanes")
    XCTAssertFalse(
      ThumbnailLoader.hasRawSidecar(at: url), "a RAW without a sidecar is not a develop")
    let queuedAfter = await loader.gridDevelopLane.queuedCount
    XCTAssertEqual(queuedAfter, queuedBefore)
    let interactiveQueued = await loader.interactiveDevelopLane.queuedCount
    XCTAssertEqual(interactiveQueued, 0)

    probe.releaseAll()
    for task in held { _ = try await task.value }
    await assertPermitsBalanced(loader)
  }

  func testEditedRawPreviewDevelopsAtOnceWhileGridDevelopsAreBusy() async throws {
    try stageRaw()
    defer { try? FileManager.default.removeItem(at: root) }
    let xml = Data(
      XMPSerializer.serialize(model: AdjustmentModel(exposure: -1), culling: CullingState()).utf8)
    try xml.write(to: SidecarPath.sidecarURL(for: raw))
    await ThumbnailDiskCache.shared.configure(folderURL: root)
    let loader = ThumbnailLoader()
    let probe = DevelopProbe()
    let gridHold = Task {
      try await loader.developOffSlot(priority: .standard, probe.develop("held-grid"))
    }
    await eventually("the grid permit is held") { probe.runningCount == 1 }
    let queuedGrid = Task {
      try await loader.developOffSlot(priority: .standard, probe.develop("queued-grid"))
    }
    let lane = await loader.gridDevelopLane
    await eventually("a grid develop is queued") { (await lane.queuedCount) == 1 }

    let url = raw!
    let previewTask = Task { await loader.loadDisplayPreview(for: AssetRef(url: url)) }
    await finish([previewTask], "the opened photo's develop must not wait behind grid develops")
    let preview = await previewTask.value
    XCTAssertNotNil(preview)
    XCTAssertEqual(probe.startedLabels, ["held-grid"])

    probe.releaseAll()
    _ = try await gridHold.value
    _ = try await queuedGrid.value
    await assertPermitsBalanced(loader)
  }

  func testEditedRawThumbnailWaitsForTheGridLaneThenCompletes() async throws {
    try stageRaw()
    defer { try? FileManager.default.removeItem(at: root) }
    let xml = Data(
      XMPSerializer.serialize(model: AdjustmentModel(exposure: -1), culling: CullingState()).utf8)
    try xml.write(to: SidecarPath.sidecarURL(for: raw))
    await ThumbnailDiskCache.shared.configure(folderURL: root)
    let loader = ThumbnailLoader()
    let probe = DevelopProbe()
    let gridHold = Task {
      try await loader.developOffSlot(priority: .standard, probe.develop("held-grid"))
    }
    await eventually("the grid permit is held") { probe.runningCount == 1 }

    let url = raw!
    let thumb = Task { await loader.load(for: url) }
    let lane = await loader.gridDevelopLane
    await eventually("the edited thumbnail's develop queues in the grid lane") {
      (await lane.queuedCount) == 1
    }

    probe.releaseAll()
    _ = try await gridHold.value
    let data = await thumb.value
    XCTAssertNotNil(data)
    await assertPermitsBalanced(loader)
  }

  func testNoEmbeddedPreviewFallbackDevelopUsesTheLane() async throws {
    root = FileManager.default.temporaryDirectory
      .appendingPathComponent("develop-lane-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    raw = root.appendingPathComponent("opaque.dng")
    try Data([0, 1, 2, 3]).write(to: raw)
    await ThumbnailDiskCache.shared.configure(folderURL: root)
    let loader = ThumbnailLoader()
    let probe = DevelopProbe()
    let gridHold = Task {
      try await loader.developOffSlot(priority: .standard, probe.develop("held-grid"))
    }
    await eventually("the grid permit is held") { probe.runningCount == 1 }

    let url = raw!
    let thumb = Task { await loader.load(for: url) }
    let lane = await loader.gridDevelopLane
    await eventually("the fallback develop queues in the grid lane") {
      (await lane.queuedCount) == 1
    }

    probe.releaseAll()
    _ = try await gridHold.value
    let data = await thumb.value
    XCTAssertNil(data)
    await assertPermitsBalanced(loader)
  }

  func testUnreadableSidecarLocationCountsAsPresentNotMissing() throws {
    try stageRaw()
    let sidecarURL = SidecarPath.sidecarURL(for: raw)
    try Data().write(to: sidecarURL)
    defer {
      try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.path)
      try? FileManager.default.removeItem(at: root)
    }
    XCTAssertTrue(ThumbnailLoader.hasRawSidecar(at: raw))
    try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: root.path)
    XCTAssertTrue(
      ThumbnailLoader.hasRawSidecar(at: raw), "a sidecar that cannot be read is not a missing one")
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.path)
    try FileManager.default.removeItem(at: sidecarURL)
    XCTAssertFalse(ThumbnailLoader.hasRawSidecar(at: raw))
  }

  func testSourceFetchProducerThatDevelopsLeavesBothLimitersBalanced() async throws {
    for failing in [false, true] {
      let loader = ThumbnailLoader()
      let producer = await loader.startLocalProducer(key: "fetch-\(failing)", gate: .sourceFetch) {
        do {
          _ = try await loader.developOffSlot(priority: .standard) {
            if failing { throw DevelopFailure() }
            return 1
          }
        } catch {}
        return nil
      }
      await finish([producer], "a source-fetch producer that develops finishes")
      let fetchSlots = await loader.sourceFetchSlots
      let fetchCapacity = ThumbnailLoader.maxConcurrentSourceFetches
      let held = Counter()
      let fillers = (0..<fetchCapacity).map { _ in
        Task {
          try await fetchSlots.acquire()
          await held.increment()
        }
      }
      await eventually("the source-fetch limiter regained every permit") {
        await held.value == fetchCapacity
      }
      let extra = Task { try await fetchSlots.acquire() }
      await eventually("the source-fetch limiter has no extra permit") {
        await fetchSlots.queuedCount == 1
      }
      extra.cancel()
      for _ in 0..<fetchCapacity { await fetchSlots.release() }
      for filler in fillers { _ = try? await filler.value }
      await assertPermitsBalanced(loader)
    }
  }
}
