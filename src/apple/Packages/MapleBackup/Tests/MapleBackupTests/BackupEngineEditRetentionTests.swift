// Tests/MapleBackupTests/BackupEngineEditRetentionTests.swift
//
// #4719: the App Support XMP is the editor's canonical PhotoKit edit, not a
// staging copy. Backup uploads it and records which revision it uploaded;
// it never deletes it — including an edit saved while the upload was in
// flight.
import CryptoKit
import XCTest
@testable import MapleBackup

final class BackupEngineEditRetentionTests: XCTestCase {

    override func setUp() {
        StubURLProtocol.stub = nil
        StubURLProtocol.clearRecording()
    }
    override func tearDown() {
        StubURLProtocol.stub = nil
        StubURLProtocol.clearRecording()
    }

    private func digest(_ xmp: String) -> String {
        SHA256.hash(data: Data(xmp.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    func testUploadRecordsTheRevisionAndKeepsTheEdit() async throws {
        StubURLProtocol.stub = ingestAndSidecarStub()
        let (engine, queue, state, sidecars, _, tmpRoot) = try freshHarness()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }
        let revisionA = "<x:xmpmeta><crs:Exposure2012>+1.5</crs:Exposure2012></x:xmpmeta>"
        try sidecars.write(phassetLocalId: "P1", xmp: revisionA)

        let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
        let task = BackupTask(id: id, state: .pending, priority: .background)
        try await state.upsert(task)
        await queue.enqueue(task, priority: .background)
        try await engine.processOne()

        XCTAssertEqual(try sidecars.read(phassetLocalId: "P1"), revisionA)
        let recorded = try await state.uploadedSidecarDigest(id)
        XCTAssertEqual(recorded, digest(revisionA))
    }

    func testEditSavedDuringTheSidecarUploadSurvivesIt() async throws {
        StubURLProtocol.stub = ingestAndSidecarStub()
        let (engine, queue, state, sidecars, _, tmpRoot) = try freshHarness()
        defer { try? FileManager.default.removeItem(at: tmpRoot) }
        let revisionA = "<x:xmpmeta><crs:Exposure2012>+1.5</crs:Exposure2012></x:xmpmeta>"
        let revisionB = "<x:xmpmeta><crs:Exposure2012>+2.0</crs:Exposure2012></x:xmpmeta>"
        try sidecars.write(phassetLocalId: "P1", xmp: revisionA)
        let root = sidecars.rootForTesting
        StubURLProtocol.onRequest = { request in
            guard request.url?.path.contains("backup/sidecar") == true else { return }
            try? AppSupportSidecarStore(root: root).write(phassetLocalId: "P1", xmp: revisionB)
        }

        let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
        let task = BackupTask(id: id, state: .pending, priority: .background)
        try await state.upsert(task)
        await queue.enqueue(task, priority: .background)
        try await engine.processOne()

        XCTAssertEqual(try sidecars.read(phassetLocalId: "P1"), revisionB,
            "an edit saved mid-upload must not be deleted")
        let recorded = try await state.uploadedSidecarDigest(id)
        XCTAssertEqual(recorded, digest(revisionA),
            "the recorded revision is the one actually uploaded, so B still reads as newer")
    }
}
