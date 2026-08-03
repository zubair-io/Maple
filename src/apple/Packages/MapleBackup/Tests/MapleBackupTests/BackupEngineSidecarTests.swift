// Tests/MapleBackupTests/BackupEngineSidecarTests.swift
//
// Split out of BackupEngineTests.swift (#2554) — sidecar upload ordering and
// local-edit preference. Split, not trimmed, to keep the hard 600-line file
// budget with real margin rather than hovering just under it (#2311).
import XCTest
@testable import MapleBackup

final class BackupEngineSidecarTests: XCTestCase {

    override func setUp() {
        StubURLProtocol.stub = nil
        StubURLProtocol.clearRecording()
    }
    override func tearDown() {
        StubURLProtocol.stub = nil
        StubURLProtocol.clearRecording()
    }

    // MARK: - Issue 1 & 2: Sidecar upload ordering + local-edit preference

    /// Assert the sidecar request is sent after the original ingest request,
    /// when there's a local edit to send one for at all.
    func testSidecarRequestSentAfterOriginal() async throws {
        StubURLProtocol.stub = ingestAndSidecarStub(relPath: "2024/03/15/IMG.heic")
        let (engine, queue, state, sidecars, _, tmpRoot) = try freshHarness()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }

        try sidecars.write(phassetLocalId: "P1", xmp: "<x:edit/>")

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

    /// Regression test for #2553: a photo backed up with no local Maple edit
    /// must not generate any sidecar upload at all. The engine used to fall
    /// back to a synthetic XMP built from bare PHAsset metadata, littering
    /// the cloud library with an empty `.xmp` next to every untouched photo
    /// the backup walk touched — violating the non-destructive invariant
    /// that a sidecar is the record of an edit, not a default backup artifact.
    func testNoSidecarUploadedWithoutLocalEdit() async throws {
        StubURLProtocol.stub = .ok(json: #"{"maple_id":"hash-P1","target_rel_path":"2024/03/15/IMG.heic"}"#)
        let (engine, queue, state, _, _, tmpRoot) = try freshHarness()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }

        let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
        let task = BackupTask(id: id, state: .pending, priority: .background)
        try await state.upsert(task)
        await queue.enqueue(task, priority: .background)

        try await engine.processOne()

        let row = try await state.find(id)
        XCTAssertEqual(row?.state, .uploaded, "the photo itself must still upload fine")

        let requests = StubURLProtocol.recordedRequests
        XCTAssertFalse(requests.contains { $0.url?.path.contains("backup/sidecar") == true },
            "no sidecar should be uploaded for a photo with no local Maple edit")
    }

    /// A local sidecar that fails to read (e.g. corrupt/non-UTF8 bytes,
    /// `AppSupportSidecarStoreError.decodeFailed`) must not crash or hang
    /// the companion step — it's treated as "no local edit" for this run
    /// (surfaced via an error log, not silently as a clean no-op) and the
    /// photo itself still uploads.
    func testCorruptLocalSidecarDoesNotBlockUpload() async throws {
        StubURLProtocol.stub = .ok(json: #"{"maple_id":"hash-P1","target_rel_path":"2024/03/15/IMG.heic"}"#)
        let (engine, queue, state, _, _, tmpRoot) = try freshHarness()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }

        // Write invalid UTF-8 bytes directly to the underlying sidecar file,
        // bypassing AppSupportSidecarStore.write (which only accepts String).
        let sidecarFile = tmpRoot.appendingPathComponent("sidecars").appendingPathComponent("P1.xmp")
        try Data([0xFE, 0xFF, 0x00, 0xFF]).write(to: sidecarFile)

        let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
        let task = BackupTask(id: id, state: .pending, priority: .background)
        try await state.upsert(task)
        await queue.enqueue(task, priority: .background)

        try await engine.processOne()

        let row = try await state.find(id)
        XCTAssertEqual(row?.state, .uploaded, "a corrupt local sidecar must not block the photo upload")

        let requests = StubURLProtocol.recordedRequests
        XCTAssertFalse(requests.contains { $0.url?.path.contains("backup/sidecar") == true },
            "a sidecar that fails to read must not be uploaded")
    }

    /// Regression test for Issue 2: when a local-edit XMP exists, the sidecar
    /// POST body must contain that XMP, not the Apple-metadata-generated one.
    func testSidecarPostUsesLocalEditXmpWhenAvailable() async throws {
        StubURLProtocol.stub = ingestAndSidecarStub(relPath: "2024/03/15/IMG.heic")
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
