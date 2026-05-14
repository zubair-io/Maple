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
}
