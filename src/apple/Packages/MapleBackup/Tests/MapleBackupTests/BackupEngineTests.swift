// Tests/MapleBackupTests/BackupEngineTests.swift
import XCTest
@testable import MapleBackup

private actor StubAssetReader: AssetReader {
    var readCount = 0
    func read(phassetLocalId: String) async throws -> AssetReadResult {
        readCount += 1
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

private actor FailingAssetReader: AssetReader {
    enum FailError: Error { case forced }
    func read(phassetLocalId: String) async throws -> AssetReadResult {
        throw FailError.forced
    }
}

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

final class BackupEngineTests: XCTestCase {

    override func setUp() {
        StubURLProtocol.stub = nil
        StubURLProtocol.clearRecording()
    }
    override func tearDown() {
        StubURLProtocol.stub = nil
        StubURLProtocol.clearRecording()
    }

    private func freshHarness() throws -> (BackupEngine, InProcessBackupQueue, BackupStateStore, AppSupportSidecarStore, StubAssetReader, URL) {
        let tmpRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("engine-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmpRoot, withIntermediateDirectories: true)
        let stateURL = tmpRoot.appendingPathComponent("state.sqlite")
        let sidecarRoot = tmpRoot.appendingPathComponent("sidecars", isDirectory: true)
        try FileManager.default.createDirectory(at: sidecarRoot, withIntermediateDirectories: true)

        let queue = InProcessBackupQueue()
        let state = try BackupStateStore(databaseURL: stateURL)
        let sidecars = AppSupportSidecarStore(root: sidecarRoot)
        let reader = StubAssetReader()
        let upload = UploadClient(baseURL: URL(string: "https://server.example")!,
                                  libraryId: "lib", deviceId: "d",
                                  session: stubSession())
        let engine = BackupEngine(queue: queue, state: state, upload: upload,
                                  sidecars: sidecars, reader: reader)
        return (engine, queue, state, sidecars, reader, tmpRoot)
    }

    /// Variant exposing the #700 `companionBackoff` injection point. Returns the
    /// 5 handles the companion tests need (the reader stub is not inspected).
    private func freshHarness(
        companionBackoff: @escaping @Sendable (Int) -> TimeInterval
    ) throws -> (BackupEngine, InProcessBackupQueue, BackupStateStore, AppSupportSidecarStore, URL) {
        let tmpRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("engine-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tmpRoot, withIntermediateDirectories: true)
        let stateURL = tmpRoot.appendingPathComponent("state.sqlite")
        let sidecarRoot = tmpRoot.appendingPathComponent("sidecars", isDirectory: true)
        try FileManager.default.createDirectory(at: sidecarRoot, withIntermediateDirectories: true)

        let queue = InProcessBackupQueue()
        let state = try BackupStateStore(databaseURL: stateURL)
        let sidecars = AppSupportSidecarStore(root: sidecarRoot)
        let reader = StubAssetReader()
        let upload = UploadClient(baseURL: URL(string: "https://server.example")!,
                                  libraryId: "lib", deviceId: "d",
                                  session: stubSession())
        let engine = BackupEngine(queue: queue, state: state, upload: upload,
                                  sidecars: sidecars, reader: reader,
                                  companionBackoff: companionBackoff)
        return (engine, queue, state, sidecars, tmpRoot)
    }

    // Convenience: a sequence stub for the standard two-request happy path
    // (ingest → 200+JSON, sidecar → 200 empty).
    private static func ingestAndSidecarStub(mapleId: String = "hash-P1",
                                              relPath: String = "2024/03/15/IMG.heic") -> StubURLProtocol.Stub {
        .sequence([
            .ok(json: #"{"maple_id":"\#(mapleId)","target_rel_path":"\#(relPath)"}"#),
            .status(200)
        ])
    }

    func testProcessOneUploadsAndPersistsUploadedState() async throws {
        StubURLProtocol.stub = Self.ingestAndSidecarStub()
        let (engine, queue, state, _, _, tmpRoot) = try freshHarness()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }

        let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
        let task = BackupTask(id: id, state: .pending, priority: .background)
        try await state.upsert(task)
        await queue.enqueue(task, priority: .background)

        try await engine.processOne()
        let row = try await state.find(id)
        XCTAssertEqual(row?.state, .uploaded)
    }

    func testProcessOneDeletesAppSupportSidecarOnSuccess() async throws {
        StubURLProtocol.stub = Self.ingestAndSidecarStub()
        let (engine, queue, state, sidecars, _, tmpRoot) = try freshHarness()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }

        let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
        try sidecars.write(phassetLocalId: "P1", xmp: "<x/>")
        XCTAssertNotNil(try sidecars.read(phassetLocalId: "P1"))

        let task = BackupTask(id: id, state: .pending, priority: .background)
        try await state.upsert(task)
        await queue.enqueue(task, priority: .background)

        try await engine.processOne()

        let after = try sidecars.read(phassetLocalId: "P1")
        XCTAssertNil(after)
    }

    func testProcessOnePersistsUploadingThenUploaded() async throws {
        StubURLProtocol.stub = Self.ingestAndSidecarStub()
        let (engine, queue, state, _, _, tmpRoot) = try freshHarness()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }

        let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
        let task = BackupTask(id: id, state: .pending, priority: .background)
        try await state.upsert(task)
        await queue.enqueue(task, priority: .background)

        // After processing, the transition should end at .uploaded.
        try await engine.processOne()
        let final = try await state.find(id)
        XCTAssertEqual(final?.state, .uploaded)
    }

    func testProcessOneReturnsWhenQueueEmpty() async throws {
        let (engine, _, _, _, _, tmpRoot) = try freshHarness()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }
        // No tasks enqueued; processOne should return without throwing.
        try await engine.processOne()
    }

    func testProcessOneRetainsSidecarOnFailure() async throws {
        StubURLProtocol.stub = .status(500)
        let (engine, queue, state, sidecars, _, tmpRoot) = try freshHarness()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }

        let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
        try sidecars.write(phassetLocalId: "P1", xmp: "<x/>")

        let task = BackupTask(id: id, state: .pending, priority: .background)
        try await state.upsert(task)
        await queue.enqueue(task, priority: .background)

        // We expect processOne to throw; retry logic transitions to .pending.
        do {
            try await engine.processOne()
            XCTFail("expected upload to throw")
        } catch {
            // OK — error propagates.
        }
        // The sidecar must NOT be deleted on failure.
        XCTAssertNotNil(try sidecars.read(phassetLocalId: "P1"))
        // After first failure the task should be back in .pending (retry queued).
        let row = try await state.find(id)
        XCTAssertEqual(row?.state, .pending)
    }

    /// Regression for #225: when `process()` re-marks the task `.pending`
    /// after a failure, the bumped retryCount must round-trip through
    /// SQLite — otherwise restart rehydration silently resets retries to 0
    /// and the `maxRetries` ceiling becomes effectively infinite.
    func testFailurePersistsBumpedRetryCountToSQLite() async throws {
        StubURLProtocol.stub = .status(500)
        let (engine, queue, state, _, _, tmpRoot) = try freshHarness()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }
        let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
        let task = BackupTask(id: id, state: .pending, priority: .background,
                              retryCount: 2)
        try await state.upsert(task)
        await queue.enqueue(task, priority: .background)
        do {
            try await engine.processOne()
            XCTFail("expected upload to fail and throw")
        } catch {
            // expected
        }
        let row = try await state.find(id)
        XCTAssertEqual(row?.state, .pending)
        XCTAssertEqual(row?.retryCount, 3,
                       "transition() must persist the bumped retryCount (#225)")
    }

    func testFailureSchedulesRetry() async throws {
        StubURLProtocol.stub = .status(500)
        let (engine, queue, state, _, _, tmpRoot) = try freshHarness()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }
        let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
        let task = BackupTask(id: id, state: .pending, priority: .background)
        try await state.upsert(task)
        await queue.enqueue(task, priority: .background)
        do {
            try await engine.processOne()
            XCTFail("expected upload to fail and throw")
        } catch {
            // expected — error propagates out of processOne
        }
        // State transitions to .pending (retry queued for later).
        let row = try await state.find(id)
        XCTAssertEqual(row?.state, .pending)
    }

    // MARK: - Issue 1 & 2: Sidecar upload ordering + local-edit preference

    /// Assert the sidecar request is sent after the original ingest request.
    func testSidecarRequestSentAfterOriginal() async throws {
        StubURLProtocol.stub = Self.ingestAndSidecarStub(relPath: "2024/03/15/IMG.heic")
        let (engine, queue, state, _, _, tmpRoot) = try freshHarness()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }

        let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
        let task = BackupTask(id: id, state: .pending, priority: .background)
        try await state.upsert(task)
        await queue.enqueue(task, priority: .background)

        try await engine.processOne()

        let requests = StubURLProtocol.recordedRequests
        XCTAssertGreaterThanOrEqual(requests.count, 2,
            "Expected at least 2 requests (ingest + sidecar), got \(requests.count)")
        // First request must be the ingest (hits /backup/ingest).
        XCTAssertTrue(requests[0].url?.path.contains("backup/ingest") == true,
            "First request should be ingest, got \(requests[0].url?.path ?? "nil")")
        // Second request must be the sidecar (hits /backup/sidecar).
        XCTAssertTrue(requests[1].url?.path.contains("backup/sidecar") == true,
            "Second request should be sidecar, got \(requests[1].url?.path ?? "nil")")
    }

    /// Regression test for Issue 2: when a local-edit XMP exists, the sidecar
    /// POST body must contain that XMP, not the Apple-metadata-generated one.
    func testSidecarPostUsesLocalEditXmpWhenAvailable() async throws {
        StubURLProtocol.stub = Self.ingestAndSidecarStub(relPath: "2024/03/15/IMG.heic")
        let (engine, queue, state, sidecars, _, tmpRoot) = try freshHarness()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }

        let localEditXmp = "<x:xmpmeta><maple:exposure>1.5</maple:exposure></x:xmpmeta>"
        try sidecars.write(phassetLocalId: "P1", xmp: localEditXmp)

        let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
        let task = BackupTask(id: id, state: .pending, priority: .background)
        try await state.upsert(task)
        await queue.enqueue(task, priority: .background)

        try await engine.processOne()

        // The sidecar should be gone (deleted after upload).
        XCTAssertNil(try sidecars.read(phassetLocalId: "P1"),
            "Local-edit sidecar should be deleted after successful upload")

        // The sidecar POST body must be the local-edit XMP.
        let requests = StubURLProtocol.recordedRequests
        let sidecarReq = requests.first(where: { $0.url?.path.contains("backup/sidecar") == true })
        XCTAssertNotNil(sidecarReq, "No sidecar POST found")
        if let body = sidecarReq?.httpBody, let bodyStr = String(data: body, encoding: .utf8) {
            XCTAssertTrue(bodyStr.contains("maple:exposure"),
                "Sidecar body should be local-edit XMP, got: \(bodyStr.prefix(200))")
        } else {
            XCTFail("Sidecar POST had no readable body")
        }
    }

    // MARK: - Cross-device coordination (HTTP 423 busy-elsewhere)

    /// 423 on the ingest call should: leave the task in `.pending` (not
    /// `.failedRetry`), keep retryCount unchanged (busy != failure), retain
    /// the local sidecar so a retry can still find user edits, emit a
    /// `.failed(willRetry: true)` event, and re-enqueue the task at the same
    /// priority/retryCount via the deferred Task. Distinct from
    /// `testFailureSchedulesRetry` because that path burns a retry slot;
    /// this path explicitly should not.
    func testBusyElsewhereKeepsPendingWithoutBurningRetry() async throws {
        // retry_after_seconds=0 so the deferred re-enqueue Task wakes up
        // immediately — the test can observe the resulting `.enqueued` event
        // without sleeping the full peer-staleness window.
        StubURLProtocol.stub = .status(
            423,
            json: #"{"error":"busy elsewhere","retry_after_seconds":0}"#)
        let (engine, queue, state, sidecars, _, tmpRoot) = try freshHarness()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }

        // Seed a local-edit sidecar so we can prove busy-elsewhere doesn't
        // accidentally nuke it (the sidecar-deletion fix is sibling to this
        // PR, but verifying the invariant here keeps the regression bar
        // visible on the same test surface).
        try sidecars.write(phassetLocalId: "P1", xmp: "<x:edit/>")

        let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
        let task = BackupTask(id: id, state: .pending, priority: .background,
                              retryCount: 0)
        try await state.upsert(task)
        await queue.enqueue(task, priority: .background)

        // Capture events fired during processOne + the deferred re-enqueue.
        let eventsStream = await queue.observe()

        do {
            try await engine.processOne()
            XCTFail("expected busy-elsewhere to throw out of processOne")
        } catch UploadClient.UploadError.busyElsewhere {
            // expected — engine rethrows after recording state + scheduling
            // the deferred re-enqueue.
        }

        // 1. State stays at .pending — NOT .failedRetry (which would mean
        //    retry count was burned past maxRetries).
        let row = try await state.find(id)
        XCTAssertEqual(row?.state, .pending,
            "busy-elsewhere should leave the task pending, not failedRetry")

        // 2. Local sidecar must still exist — the deferred retry will need it.
        XCTAssertNotNil(try sidecars.read(phassetLocalId: "P1"),
            "Local sidecar must survive busy-elsewhere so the retry can use it")

        // 3. Walk the event stream until we see both a `.failed(willRetry:true)`
        //    and the re-enqueue. Cap with a short timeout so a regression that
        //    fails to re-enqueue can't hang the test indefinitely.
        var sawFailed = false
        var sawReEnqueue = false
        var reEnqueuedRetryCount: Int? = nil
        let deadline = Date().addingTimeInterval(2.0)
        var iterator = eventsStream.makeAsyncIterator()
        while Date() < deadline, !(sawFailed && sawReEnqueue) {
            let next = await withTaskGroup(of: BackupQueueEvent?.self) { group -> BackupQueueEvent? in
                group.addTask { await iterator.next() }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 200_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first ?? nil
            }
            guard let event = next else { continue }
            switch event {
            case .failed(let eid, _, let willRetry) where eid == id:
                XCTAssertTrue(willRetry,
                    "busy-elsewhere must emit willRetry=true")
                sawFailed = true
            case .enqueued(let reTask) where reTask.id == id:
                sawReEnqueue = true
                reEnqueuedRetryCount = reTask.retryCount
            default:
                break
            }
        }
        XCTAssertTrue(sawFailed, "expected .failed event with willRetry=true")
        XCTAssertTrue(sawReEnqueue, "expected the task to be re-enqueued")
        XCTAssertEqual(reEnqueuedRetryCount, 0,
            "busy-elsewhere is coordination, not failure — retryCount must not be burned")
    }

    // MARK: - #700: best-effort companions

    /// Count recorded requests whose URL path contains `needle`.
    private func requestCount(containing needle: String) -> Int {
        StubURLProtocol.recordedRequests.filter {
            $0.url?.path.contains(needle) == true
        }.count
    }

    /// Poll until `predicate` holds or the deadline elapses. Avoids sleeping a
    /// fixed duration when waiting on the detached companion-retry path.
    private func wait(timeout: TimeInterval = 2.0,
                      until predicate: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if predicate() { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    /// A sidecar (companion) failure must leave the PHOTO uploaded, must NOT
    /// re-upload the bytes, and must retry the sidecar separately until it
    /// lands. The discriminator for "bytes not re-uploaded" is that retries
    /// hit `/sidecar`, never `/ingest` — so the ingest request count stays 1.
    func testCompanionFailureLeavesPhotoUploadedAndRetriesSidecar() async throws {
        // ingest 200+json → sidecar 500 (inline) → sidecar 200 (retry).
        StubURLProtocol.stub = .sequence([
            .ok(json: #"{"maple_id":"hash-P1","target_rel_path":"2024/03/15/IMG.heic"}"#),
            .status(500),
            .status(200),
        ])
        let (engine, queue, state, sidecars, tmpRoot) =
            try freshHarness(companionBackoff: { _ in 0 })
        defer { try? FileManager.default.removeItem(at: tmpRoot) }
        // Cancel any lingering companion-retry task so it can't leak into the
        // next test's global StubURLProtocol state.
        let engineRef = engine
        defer { Task { await engineRef.stop() } }

        // Seed a local-edit sidecar so the durability-critical path is exercised
        // and we can assert delete-only-after-it-lands.
        try sidecars.write(phassetLocalId: "P1", xmp: "<x:edit/>")

        let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
        let task = BackupTask(id: id, state: .pending, priority: .background)
        try await state.upsert(task)
        await queue.enqueue(task, priority: .background)

        // processOne returns once the inline sidecar attempt fails (no throw).
        try await engine.processOne()

        // The photo is uploaded despite the sidecar hiccup.
        let row = try await state.find(id)
        XCTAssertEqual(row?.state, .uploaded,
            "a companion failure must not fail the photo")

        // The sidecar retry eventually lands (2nd sidecar request).
        await wait { self.requestCount(containing: "backup/sidecar") >= 2 }
        XCTAssertGreaterThanOrEqual(requestCount(containing: "backup/sidecar"), 2,
            "the sidecar companion must be retried separately until it lands")

        // Bytes were never re-uploaded — exactly one ingest request total.
        XCTAssertEqual(requestCount(containing: "backup/ingest"), 1,
            "a companion failure must NOT re-upload the photo bytes")

        // The local-edit sidecar is deleted only after the retry succeeds.
        await wait { (try? sidecars.read(phassetLocalId: "P1")) == nil }
        XCTAssertNil(try sidecars.read(phassetLocalId: "P1"),
            "local sidecar should be deleted once the sidecar upload finally lands")
    }

    /// Sidecar-idempotency invariant: while the sidecar upload is still failing,
    /// the local-edit XMP must remain on disk so a retry re-derives correctly.
    func testLocalSidecarRetainedUntilSidecarUploadSucceeds() async throws {
        // ingest 200+json → sidecar 500 forever (sequence exhausts → 500).
        StubURLProtocol.stub = .sequence([
            .ok(json: #"{"maple_id":"hash-P1","target_rel_path":"2024/03/15/IMG.heic"}"#),
            .status(500),
        ])
        // Hold the companion retry off (large backoff) so the inline 500 is the
        // only sidecar attempt during the assertion window.
        let (engine, queue, state, sidecars, tmpRoot) =
            try freshHarness(companionBackoff: { _ in 999 })
        defer { try? FileManager.default.removeItem(at: tmpRoot) }
        let engineRef = engine
        defer { Task { await engineRef.stop() } }

        try sidecars.write(phassetLocalId: "P1", xmp: "<x:edit/>")

        let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
        let task = BackupTask(id: id, state: .pending, priority: .background)
        try await state.upsert(task)
        await queue.enqueue(task, priority: .background)

        try await engine.processOne()

        // Photo uploaded, but the sidecar upload failed — the local XMP must
        // survive so the bounded retry (and any future walk) can re-derive it.
        let rowState = try await state.find(id)?.state
        XCTAssertEqual(rowState, .uploaded)
        XCTAssertNotNil(try sidecars.read(phassetLocalId: "P1"),
            "local sidecar must NOT be deleted before the sidecar upload lands")
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
                                  session: stubSession())
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
                                  session: stubSession())
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
