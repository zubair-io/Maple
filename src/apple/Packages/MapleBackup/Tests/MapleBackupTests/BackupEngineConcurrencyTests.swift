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
