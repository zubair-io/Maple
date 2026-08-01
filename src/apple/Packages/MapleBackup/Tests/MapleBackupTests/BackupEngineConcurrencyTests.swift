// Tests/MapleBackupTests/BackupEngineConcurrencyTests.swift
// Concurrency-cap tests for BackupEngine.run() (#700), split out of
// BackupEngineTests to keep that file under the 600-line budget (#702).
import XCTest
@testable import MapleBackup

/// Reader that tracks the peak number of concurrent `read(...)` calls, so a
/// test can assert the engine's `maxConcurrency` cap holds. The increment is
/// synchronous-on-entry (before the first `await`), so reentrancy during the
/// sleep registers overlapping reads in `peak`.
private actor CountingAssetReader: AssetReader {
    private(set) var current = 0
    private(set) var peak = 0
    private let holdNanos: UInt64

    init(holdMillis: UInt64 = 50) { self.holdNanos = holdMillis * 1_000_000 }

    func read(phassetLocalId: String) async throws -> AssetReadResult {
        current += 1
        peak = max(peak, current)
        try? await Task.sleep(nanoseconds: holdNanos)
        current -= 1
        return AssetReadResult(
            originalBytes: Data(count: 256),
            renderedBytes: nil,
            sidecar: PayloadAssembler.SidecarInput(
                phassetLocalId: phassetLocalId,
                deviceId: "d",
                captureDate: Date(timeIntervalSince1970: 1_700_000_000),
                latitude: nil, longitude: nil,
                favorite: false, caption: nil,
                keywords: [], tags: [],
                livePhotoCompanion: nil, burstStackId: nil,
                originalFilename: "IMG.heic",
                mtime: 0),
            mapleId: "hash-\(phassetLocalId)")
    }
}

final class BackupEngineConcurrencyTests: XCTestCase {

    override func setUp() {
        StubURLProtocol.stub = nil
        StubURLProtocol.clearRecording()
    }
    override func tearDown() {
        StubURLProtocol.stub = nil
        StubURLProtocol.clearRecording()
    }

    /// The `maxConcurrency` override caps how many `process(task:)` runs proceed
    /// in parallel inside `run()`. With cap=2 and 6 queued tasks, the gating
    /// reader's peak concurrent-read count must saturate at exactly 2.
    func testConcurrencyCapIsRespected() async throws {
        // Single always-200 stub: every /ingest returns the maple_id JSON and
        // every /sidecar returns 200 — no companion retries linger, so run()
        // terminates once the queue drains.
        StubURLProtocol.stub = .ok(
            json: #"{"maple_id":"m","target_rel_path":"2024/03/15/IMG.heic"}"#)

        let tmpRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("engine-conc-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmpRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpRoot) }
        let stateURL = tmpRoot.appendingPathComponent("state.sqlite")
        let sidecarRoot = tmpRoot.appendingPathComponent("sidecars", isDirectory: true)
        try FileManager.default.createDirectory(at: sidecarRoot, withIntermediateDirectories: true)

        let queue = InProcessBackupQueue()
        let state = try BackupStateStore(databaseURL: stateURL)
        let sidecars = AppSupportSidecarStore(root: sidecarRoot)
        let reader = CountingAssetReader(holdMillis: 60)
        let upload = UploadClient(baseURL: URL(string: "https://server.example")!,
                                  libraryId: "lib", deviceId: "d",
                                  transport: stubTransport())
        let engine = BackupEngine(queue: queue, state: state, upload: upload,
                                  sidecars: sidecars, reader: reader,
                                  maxConcurrency: 2)

        for i in 0..<6 {
            let id = BackupTaskID(deviceId: "d", phassetLocalId: "P\(i)")
            let t = BackupTask(id: id, state: .pending, priority: .background)
            try await state.upsert(t)
            await queue.enqueue(t, priority: .background)
        }

        await engine.run()

        let peak = await reader.peak
        XCTAssertLessThanOrEqual(peak, 2,
            "engine must not exceed the maxConcurrency=2 cap")
        XCTAssertEqual(peak, 2,
            "with 6 tasks and a gating reader the cap should actually be reached")
    }

    /// The default concurrency is 8 (raised from 4 in #700). Exercised via the
    /// gating reader with 12 queued tasks against the default-constructed engine.
    func testDefaultConcurrencyIsEight() async throws {
        StubURLProtocol.stub = .ok(
            json: #"{"maple_id":"m","target_rel_path":"2024/03/15/IMG.heic"}"#)

        let tmpRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("engine-conc8-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmpRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpRoot) }
        let stateURL = tmpRoot.appendingPathComponent("state.sqlite")
        let sidecarRoot = tmpRoot.appendingPathComponent("sidecars", isDirectory: true)
        try FileManager.default.createDirectory(at: sidecarRoot, withIntermediateDirectories: true)

        let queue = InProcessBackupQueue()
        let state = try BackupStateStore(databaseURL: stateURL)
        let sidecars = AppSupportSidecarStore(root: sidecarRoot)
        let reader = CountingAssetReader(holdMillis: 60)
        let upload = UploadClient(baseURL: URL(string: "https://server.example")!,
                                  libraryId: "lib", deviceId: "d",
                                  transport: stubTransport())
        // Default init — no maxConcurrency override.
        let engine = BackupEngine(queue: queue, state: state, upload: upload,
                                  sidecars: sidecars, reader: reader)

        for i in 0..<12 {
            let id = BackupTaskID(deviceId: "d", phassetLocalId: "Q\(i)")
            let t = BackupTask(id: id, state: .pending, priority: .background)
            try await state.upsert(t)
            await queue.enqueue(t, priority: .background)
        }

        await engine.run()

        let peak = await reader.peak
        XCTAssertLessThanOrEqual(peak, 8,
            "default cap must be 8 — never more")
        XCTAssertEqual(peak, 8,
            "with 12 tasks the default cap of 8 should be reached")
    }
}

// MARK: - #1026: event-driven retry wakeup (replaces the 1s poll in run())

/// Wraps `InProcessBackupQueue`, timestamping every `dequeue()` call so a test
/// can see exactly when `run()`'s loop went back to the queue. A periodic
/// poll leaves a fingerprint here — a `dequeue()` call roughly every second
/// while idle; an event-driven wakeup only calls back in right after a retry
/// actually re-enqueues.
private actor DequeueSpyQueue: BackupQueue {
    private let inner = InProcessBackupQueue()
    private(set) var dequeueTimestamps: [Date] = []

    func enqueue(_ task: BackupTask, priority: BackupPriority) async {
        await inner.enqueue(task, priority: priority)
    }
    func cancel(_ id: BackupTaskID) async { await inner.cancel(id) }
    func dequeue() async -> BackupTask? {
        dequeueTimestamps.append(Date())
        return await inner.dequeue()
    }
    // Not exercised by these tests — a minimal conformance is enough; forwarding
    // to `inner.observe()` isn't possible here since the protocol requires this
    // to stay synchronous while `inner` is a different actor.
    func observe() -> AsyncStream<BackupQueueEvent> { AsyncStream { _ in } }
    func snapshot() async -> [BackupTask] { await inner.snapshot() }
    func emit(_ event: BackupQueueEvent) async { await inner.emit(event) }
}

final class BackupEngineRetryWakeupTests: XCTestCase {

    override func setUp() {
        StubURLProtocol.stub = nil
        StubURLProtocol.clearRecording()
    }
    override func tearDown() {
        StubURLProtocol.stub = nil
        StubURLProtocol.clearRecording()
    }

    /// Fresh state store + sidecar store in a throwaway tmp dir. Callers pick
    /// whichever `BackupQueue` implementation the test needs (a plain
    /// `InProcessBackupQueue`, or the timestamping `DequeueSpyQueue` below).
    private func harness() throws -> (BackupStateStore, AppSupportSidecarStore, URL) {
        let tmpRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("engine-wake-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmpRoot, withIntermediateDirectories: true)
        let stateURL = tmpRoot.appendingPathComponent("state.sqlite")
        let sidecarRoot = tmpRoot.appendingPathComponent("sidecars", isDirectory: true)
        try FileManager.default.createDirectory(at: sidecarRoot, withIntermediateDirectories: true)
        return (try BackupStateStore(databaseURL: stateURL),
                AppSupportSidecarStore(root: sidecarRoot), tmpRoot)
    }

    /// Await `task` or fail if it hangs — a regression here would otherwise
    /// stall the whole test run instead of failing fast.
    private func awaitCompletion(of task: Task<Void, Never>, timeout: TimeInterval,
                                 file: StaticString = #filePath, line: UInt = #line) async {
        let finished = await withTaskGroup(of: Bool.self) { group -> Bool in
            group.addTask { await task.value; return true }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                return false
            }
            let first = await group.next() ?? false
            group.cancelAll()
            return first
        }
        XCTAssertTrue(finished, "did not complete within \(timeout)s — possible hang",
                      file: file, line: line)
    }

    /// (a) A failed upload's retry re-enqueues and `run()` — parked on the
    /// event-driven wait, not a poll — picks it up and finishes the task.
    /// The elapsed time is bounded close to the fixed ~2s first-retry
    /// backoff, proving the wake doesn't add the up-to-1s latency a fixed
    /// poll tick could have added on top of it.
    func testRunProcessesRetryAfterEventDrivenWake() async throws {
        StubURLProtocol.stub = .sequence([
            .status(500),
            .ok(json: #"{"maple_id":"hash-P1","target_rel_path":"2024/03/15/IMG.heic"}"#),
            .status(200),
        ])
        let (state, sidecars, tmpRoot) = try harness()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }
        let queue = InProcessBackupQueue()
        let upload = UploadClient(baseURL: URL(string: "https://server.example")!,
                                  libraryId: "lib", deviceId: "d",
                                  transport: stubTransport())
        let engine = BackupEngine(queue: queue, state: state, upload: upload,
                                  sidecars: sidecars, reader: StubAssetReader())

        let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
        let task = BackupTask(id: id, state: .pending, priority: .background)
        try await state.upsert(task)
        await queue.enqueue(task, priority: .background)

        let start = Date()
        await engine.run()
        let elapsed = Date().timeIntervalSince(start)

        let row = try await state.find(id)
        XCTAssertEqual(row?.state, .uploaded, "the retried upload should land")
        XCTAssertLessThan(elapsed, 2.5,
            "retry should fire promptly off the ~2s backoff, not after an extra poll tick (got \(elapsed)s)")
    }

    /// (b) While idle with a retry pending, `run()` must not wake on a fixed
    /// interval. With a 2s first-retry backoff, a 1s poll would produce a
    /// `dequeue()` call around the 1s mark even though nothing has changed.
    /// The event-driven wait must leave that window silent.
    func testRunDoesNotWakeOnFixedIntervalWhileRetryPending() async throws {
        StubURLProtocol.stub = .status(500)
        let (state, sidecars, tmpRoot) = try harness()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }
        let spyQueue = DequeueSpyQueue()
        let upload = UploadClient(baseURL: URL(string: "https://server.example")!,
                                  libraryId: "lib", deviceId: "d",
                                  transport: stubTransport())
        let engine = BackupEngine(queue: spyQueue, state: state, upload: upload,
                                  sidecars: sidecars, reader: StubAssetReader(),
                                  maxConcurrency: 1)

        let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
        let task = BackupTask(id: id, state: .pending, priority: .background)
        try await state.upsert(task)
        await spyQueue.enqueue(task, priority: .background)

        let start = Date()
        let runnerTask = Task { await engine.run() }

        // Let the first failure land (near-instant) and the ~2s backoff run
        // well past where a 1s poll would have ticked, then tear down.
        try? await Task.sleep(nanoseconds: 2_300_000_000)
        await engine.stop()
        runnerTask.cancel()
        await awaitCompletion(of: runnerTask, timeout: 2.0)

        let timestamps = await spyQueue.dequeueTimestamps
        let offsets = timestamps.map { $0.timeIntervalSince(start) }
        let quietWindowHits = offsets.filter { $0 > 0.4 && $0 < 1.6 }
        XCTAssertTrue(quietWindowHits.isEmpty,
            "no dequeue() call should land in the 0.4s–1.6s quiet window while parked on a 2s-out retry — a fixed 1s poll would have ticked here, got offsets \(offsets)")
    }

    /// (c) `stop()` still tears down cleanly (no hang) when `run()` is
    /// currently parked on the event-driven wait — the wake must fire on
    /// teardown, not only on a genuine retry.
    func testStopTearsDownCleanlyWhileParkedOnRetry() async throws {
        StubURLProtocol.stub = .status(500)
        let (state, sidecars, tmpRoot) = try harness()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }
        let queue = InProcessBackupQueue()
        let upload = UploadClient(baseURL: URL(string: "https://server.example")!,
                                  libraryId: "lib", deviceId: "d",
                                  transport: stubTransport())
        let engine = BackupEngine(queue: queue, state: state, upload: upload,
                                  sidecars: sidecars, reader: StubAssetReader(),
                                  maxConcurrency: 1)

        let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
        let task = BackupTask(id: id, state: .pending, priority: .background)
        try await state.upsert(task)
        await queue.enqueue(task, priority: .background)

        let runnerTask = Task { await engine.run() }
        // Give the inline failure + retry scheduling time to land, so run()
        // is genuinely parked (queue empty, a retry sleeping ~2s out) before
        // teardown — the scenario the fixed-interval poll used to cover.
        try? await Task.sleep(nanoseconds: 150_000_000)

        await engine.stop()
        runnerTask.cancel()
        await awaitCompletion(of: runnerTask, timeout: 1.0)
    }
}
