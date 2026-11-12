// Tests/MapleBackupTests/BackupEngineRetryWakeupTests.swift
// #1026: run() parks on an event-driven wake (no fixed poll) while upload
// retries sleep their backoff. Split out of BackupEngineConcurrencyTests and
// made deterministic for #5127: the retry backoff is an injected gate the test
// releases, so nothing here asserts an upper bound on elapsed wall-clock time.
import XCTest

@testable import MapleBackup

/// Wraps `InProcessBackupQueue`, counting `dequeue()` calls so a test can see
/// exactly when `run()`'s loop went back to the queue. A periodic poll leaves
/// a fingerprint here — a `dequeue()` call every tick while idle; the
/// event-driven wait only calls back in after a retry re-enqueues.
private actor DequeueSpyQueue: BackupQueue {
  private let inner = InProcessBackupQueue()
  private(set) var dequeues = 0
  private(set) var emptyDequeues = 0
  private var emptyWaiters: [(count: Int, continuation: CheckedContinuation<Void, Never>)] = []

  func enqueue(_ task: BackupTask, priority: BackupPriority) async {
    await inner.enqueue(task, priority: priority)
  }
  func cancel(_ id: BackupTaskID) async { await inner.cancel(id) }
  func dequeue() async -> BackupTask? {
    dequeues += 1
    let task = await inner.dequeue()
    if task == nil {
      emptyDequeues += 1
      let ready = emptyWaiters.filter { $0.count <= emptyDequeues }
      emptyWaiters.removeAll { $0.count <= emptyDequeues }
      for waiter in ready { waiter.continuation.resume() }
    }
    return task
  }

  /// Suspends until `run()` has found the queue empty `count` times. With a
  /// retry outstanding, the first empty dequeue is the one `run()` makes right
  /// before it parks on its retry wake.
  func awaitEmptyDequeues(_ count: Int) async {
    if emptyDequeues >= count { return }
    await withCheckedContinuation { emptyWaiters.append((count, $0)) }
  }

  // Not exercised by these tests — a minimal conformance is enough; forwarding
  // to `inner.observe()` isn't possible here since the protocol requires this
  // to stay synchronous while `inner` is a different actor.
  func observe() -> AsyncStream<BackupQueueEvent> { AsyncStream { _ in } }
  func snapshot() async -> [BackupTask] { await inner.snapshot() }
  func emit(_ event: BackupQueueEvent) async { await inner.emit(event) }
}

/// Test-controlled stand-in for the engine's retry backoff sleep. Each sleep
/// records the requested backoff and parks until `release()`, so the test —
/// not a 2 s timer racing a loaded host — decides when the retry re-enqueues.
/// Like `Task.sleep`, it returns as soon as the sleeping task is cancelled:
/// `stop()` cancels each retry and awaits it.
private actor RetryBackoffGate {
  private(set) var requested: [TimeInterval] = []
  private(set) var released = false
  private var sleepers: [UUID: CheckedContinuation<Void, Never>] = [:]
  private var requestWaiters: [CheckedContinuation<Void, Never>] = []

  func sleep(_ seconds: TimeInterval) async {
    requested.append(seconds)
    for waiter in requestWaiters { waiter.resume() }
    requestWaiters.removeAll()
    let id = UUID()
    await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        if released || Task.isCancelled {
          continuation.resume()
        } else {
          sleepers[id] = continuation
        }
      }
    } onCancel: {
      Task.detached { await self.wake(id) }
    }
  }

  func release() {
    released = true
    for sleeper in sleepers.values { sleeper.resume() }
    sleepers.removeAll()
  }

  /// The first backoff the engine asked to sleep, once it has asked.
  func firstRequest() async -> TimeInterval {
    if requested.isEmpty {
      await withCheckedContinuation { requestWaiters.append($0) }
    }
    return requested[0]
  }

  private func wake(_ id: UUID) {
    sleepers.removeValue(forKey: id)?.resume()
  }
}

final class BackupEngineRetryWakeupTests: XCTestCase {

  /// Hang guard only: every wait below completes on an event, and on an idle
  /// machine within milliseconds. A load-dependent upper bound on elapsed time
  /// is exactly what made this suite flaky (#5127).
  private let hangGuard: TimeInterval = 60

  override func setUp() {
    StubURLProtocol.stub = nil
    StubURLProtocol.clearRecording()
  }
  override func tearDown() {
    StubURLProtocol.stub = nil
    StubURLProtocol.clearRecording()
  }

  /// A companion retry outstanding must not strand `run()`.
  ///
  /// The companion path (`scheduleCompanionRetry`) puts an entry in
  /// `retryTasks` but never enqueues to the upload queue — and before this
  /// fix it never signalled either. So once the queue drained, `run()` saw a
  /// non-empty `retryTasks`, parked on `retryWake.wait()`, and no wake could
  /// ever arrive: the companion finished, its entry was removed silently, and
  /// the runner stayed suspended forever. With `isRunning` latched, every
  /// later `run()` was then a no-op and backup was dead until relaunch.
  ///
  /// The 1 s poll masked this — it re-checked `retryTasks` each tick and
  /// exited once the entry cleared. Replacing the poll with an indefinite
  /// park is what turned it fatal, so it is this ticket's regression to own.
  ///
  /// Deterministic, not a race: with the bug, `run()` cannot return.
  func testCompanionRetryDoesNotStrandRun() async throws {
    // ingest 200+json → sidecar 500 (inline attempt fails, schedules the
    // companion retry) → sidecar 200 (the retry lands).
    StubURLProtocol.stub = .sequence([
      .ok(json: #"{"maple_id":"hash-P1","target_rel_path":"2024/03/15/IMG.heic"}"#),
      .status(500),
      .status(200),
    ])
    let (state, sidecars, tmpRoot) = try harness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    let queue = InProcessBackupQueue()
    let engine = BackupEngine(
      queue: queue, state: state, upload: upload(),
      sidecars: sidecars, reader: StubAssetReader(),
      maxConcurrency: 1,
      companionBackoff: { _ in 0 })
    defer { Task { await engine.stop() } }

    // A local-edit sidecar makes the companion path run for real.
    try sidecars.write(phassetLocalId: "P1", xmp: "<x:edit/>")
    let id = try await enqueue(into: queue, state: state)

    // `run()` must return on its own once the queue drains and the
    // companion retires. Before the fix it parks here indefinitely.
    let runner = Task { await engine.run() }
    await awaitCompletion(of: runner)

    let row = try await state.find(id)
    XCTAssertEqual(
      row?.state, .uploaded,
      "the photo still uploads — the companion is best-effort")
  }

  /// (a) A failed upload schedules its retry on the static backoff schedule,
  /// and `run()` — parked on the event-driven wait, not a poll — picks the
  /// retry up the moment it re-enqueues and finishes the task. The gate holds
  /// the retry until `run()` has parked, so the wake is what resumes it.
  func testRunProcessesRetryAfterEventDrivenWake() async throws {
    StubURLProtocol.stub = .sequence([
      .status(500),
      .ok(json: #"{"maple_id":"hash-P1","target_rel_path":"2024/03/15/IMG.heic"}"#),
      .status(200),
    ])
    let (state, sidecars, tmpRoot) = try harness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    let spyQueue = DequeueSpyQueue()
    let gate = RetryBackoffGate()
    let engine = BackupEngine(
      queue: spyQueue, state: state, upload: upload(),
      sidecars: sidecars, reader: StubAssetReader(),
      retrySleep: { await gate.sleep($0) })
    let id = try await enqueue(into: spyQueue, state: state)

    let runner = Task { await engine.run() }
    let backoff = await bounded { await gate.firstRequest() }
    XCTAssertEqual(backoff, BackupEngine.backoffSeconds(for: 1), "first retry backs off 2 s")
    await awaitParked(spyQueue)
    await gate.release()
    await awaitCompletion(of: runner)

    let row = try await state.find(id)
    XCTAssertEqual(row?.state, .uploaded, "the retried upload should land")
  }

  /// (b) While parked with a retry pending, `run()` must not wake on a fixed
  /// interval. The gate keeps the retry pending for as long as the test
  /// watches, so the only way `dequeue()` is called again is a poll. The
  /// watch window is a minimum, never a bound: a slow host only lengthens it.
  func testRunDoesNotWakeOnFixedIntervalWhileRetryPending() async throws {
    StubURLProtocol.stub = .status(500)
    let (state, sidecars, tmpRoot) = try harness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    let spyQueue = DequeueSpyQueue()
    let gate = RetryBackoffGate()
    let engine = BackupEngine(
      queue: spyQueue, state: state, upload: upload(),
      sidecars: sidecars, reader: StubAssetReader(),
      maxConcurrency: 1,
      retrySleep: { await gate.sleep($0) })
    _ = try await enqueue(into: spyQueue, state: state)

    let runnerTask = Task { await engine.run() }
    await awaitParked(spyQueue)
    let parkedDequeues = await spyQueue.dequeues
    // Longer than the 1 s tick the event-driven wait replaced.
    try? await Task.sleep(nanoseconds: 1_500_000_000)
    let laterDequeues = await spyQueue.dequeues
    let retryStillPending = !(await gate.released)

    await engine.stop()
    await awaitCompletion(of: runnerTask)

    XCTAssertTrue(retryStillPending)
    XCTAssertEqual(
      laterDequeues, parkedDequeues,
      "run() went back to the queue while parked on a pending retry — a fixed-interval poll")
  }

  /// (c) `stop()` alone tears `run()` down (no hang, no runner cancellation)
  /// while it is parked on the event-driven wait — the wake must fire on
  /// teardown, not only on a genuine retry.
  func testStopTearsDownCleanlyWhileParkedOnRetry() async throws {
    StubURLProtocol.stub = .status(500)
    let (state, sidecars, tmpRoot) = try harness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    let spyQueue = DequeueSpyQueue()
    let gate = RetryBackoffGate()
    let engine = BackupEngine(
      queue: spyQueue, state: state, upload: upload(),
      sidecars: sidecars, reader: StubAssetReader(),
      maxConcurrency: 1,
      retrySleep: { await gate.sleep($0) })
    _ = try await enqueue(into: spyQueue, state: state)

    let runnerTask = Task { await engine.run() }
    await awaitParked(spyQueue)

    await engine.stop()
    await awaitCompletion(of: runnerTask)
    let released = await gate.released
    XCTAssertFalse(released, "teardown, not the retry, unparked run()")
  }

  /// (d) A second concurrent `run()` call must not strand the first.
  /// `RetryWakeSignal` has exactly one continuation slot — two loops both
  /// parking on it would race to overwrite one another's continuation,
  /// permanently stranding whichever registered first once the retry
  /// landed and only the other, still-registered waiter got woken. `run()`
  /// guards against this with `isRunning`, making a second concurrent call
  /// a safe no-op instead: B returns while A is still parked on the retry.
  func testConcurrentRunCallsDoNotStrandTheFirst() async throws {
    StubURLProtocol.stub = .sequence([
      .status(500),
      .ok(json: #"{"maple_id":"hash-P1","target_rel_path":"2024/03/15/IMG.heic"}"#),
      .status(200),
    ])
    let (state, sidecars, tmpRoot) = try harness()
    defer { try? FileManager.default.removeItem(at: tmpRoot) }
    let spyQueue = DequeueSpyQueue()
    let gate = RetryBackoffGate()
    let engine = BackupEngine(
      queue: spyQueue, state: state, upload: upload(),
      sidecars: sidecars, reader: StubAssetReader(),
      maxConcurrency: 1,
      retrySleep: { await gate.sleep($0) })
    let id = try await enqueue(into: spyQueue, state: state)

    let runnerA = Task { await engine.run() }
    // A has dequeued, failed, scheduled the retry and is parking on
    // retryWake.wait() — the window where an unguarded RetryWakeSignal lets
    // a second waiter overwrite the first's parked continuation.
    await awaitParked(spyQueue)
    let runnerB = Task { await engine.run() }
    await awaitCompletion(of: runnerB)
    let dequeuesAfterB = await spyQueue.dequeues
    XCTAssertEqual(dequeuesAfterB, 2, "the second run() is a no-op while the first runs")

    await gate.release()
    await awaitCompletion(of: runnerA)

    let row = try await state.find(id)
    XCTAssertEqual(
      row?.state, .uploaded,
      "the retried upload must still complete despite a concurrent second run() call")
  }

  // MARK: - Helpers

  /// Fresh state store + sidecar store in a throwaway tmp dir.
  private func harness() throws -> (BackupStateStore, AppSupportSidecarStore, URL) {
    let tmpRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent("engine-wake-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: tmpRoot, withIntermediateDirectories: true)
    let stateURL = tmpRoot.appendingPathComponent("state.sqlite")
    let sidecarRoot = tmpRoot.appendingPathComponent("sidecars", isDirectory: true)
    try FileManager.default.createDirectory(at: sidecarRoot, withIntermediateDirectories: true)
    return (
      try BackupStateStore(databaseURL: stateURL),
      AppSupportSidecarStore(root: sidecarRoot), tmpRoot
    )
  }

  private func upload() -> UploadClient {
    UploadClient(
      baseURL: URL(string: "https://server.example")!,
      libraryId: "lib", deviceId: "d",
      transport: stubTransport())
  }

  /// Persist and queue the one photo every case backs up.
  private func enqueue(
    into queue: any BackupQueue, state: BackupStateStore
  ) async throws -> BackupTaskID {
    let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
    let task = BackupTask(id: id, state: .pending, priority: .background)
    try await state.upsert(task)
    await queue.enqueue(task, priority: .background)
    return id
  }

  /// Wait until `run()` found the queue empty with the retry outstanding —
  /// the dequeue it makes immediately before parking on its retry wake.
  private func awaitParked(
    _ queue: DequeueSpyQueue, file: StaticString = #filePath, line: UInt = #line
  ) async {
    let parked = await bounded { await queue.awaitEmptyDequeues(1) } != nil
    XCTAssertTrue(parked, "run() never parked on the pending retry", file: file, line: line)
  }

  /// `operation`'s result, or nil if it is still running after `hangGuard`.
  private func bounded<T: Sendable>(
    _ operation: @escaping @Sendable () async -> T
  ) async -> T? {
    await awaitBounded(timeout: hangGuard, operation)
  }

  /// Await `task` or fail if it hangs — a regression here would otherwise
  /// stall the whole test run instead of failing fast. See `awaitBounded`
  /// (`Helpers/TestShared.swift`) for why this can't be a `withTaskGroup`.
  private func awaitCompletion(
    of task: Task<Void, Never>, file: StaticString = #filePath, line: UInt = #line
  ) async {
    let finished = await bounded { await task.value } != nil
    XCTAssertTrue(
      finished, "did not complete within \(hangGuard)s — hang", file: file, line: line)
  }
}
