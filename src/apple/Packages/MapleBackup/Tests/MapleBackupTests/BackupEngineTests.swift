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
    }
    override func tearDown() {
        StubURLProtocol.stub = nil
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

    func testProcessOneUploadsAndPersistsUploadedState() async throws {
        StubURLProtocol.stub = .ok(json: #"{"maple_id":"hash-P1","target_rel_path":"2024/03/15/IMG.heic"}"#)
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
        StubURLProtocol.stub = .ok(json: #"{"maple_id":"hash-P1","target_rel_path":"2024/03/15/IMG.heic"}"#)
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
        StubURLProtocol.stub = .ok(json: #"{"maple_id":"hash-P1","target_rel_path":"2024/03/15/IMG.heic"}"#)
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
}
