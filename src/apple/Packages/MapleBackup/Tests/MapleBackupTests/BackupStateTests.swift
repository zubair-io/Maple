// Tests/MapleBackupTests/BackupStateTests.swift
import XCTest
@testable import MapleBackup

final class BackupStateTests: XCTestCase {
    private func freshStore() throws -> BackupStateStore {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("backup-state-\(UUID().uuidString).sqlite")
        return try BackupStateStore(databaseURL: url)
    }

    func testInsertAndAllTasks() async throws {
        let store = try freshStore()
        let t = BackupTask(
            id: BackupTaskID(deviceId: "d", phassetLocalId: "P1"),
            state: .pending, priority: .background)
        try await store.upsert(t)
        let all = try await store.allTasks()
        XCTAssertEqual(all.count, 1)
        XCTAssertEqual(all[0].state, .pending)
        XCTAssertEqual(all[0].id.phassetLocalId, "P1")
    }

    func testUpsertReplacesByPrimaryKey() async throws {
        let store = try freshStore()
        let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
        try await store.upsert(BackupTask(id: id, state: .pending, priority: .background))
        try await store.upsert(BackupTask(id: id, state: .uploading, priority: .userEdit, retryCount: 3))
        let all = try await store.allTasks()
        XCTAssertEqual(all.count, 1)
        XCTAssertEqual(all[0].state, .uploading)
        XCTAssertEqual(all[0].priority, .userEdit)
        XCTAssertEqual(all[0].retryCount, 3)
    }

    func testTransitionSetsStateAndError() async throws {
        let store = try freshStore()
        let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
        try await store.upsert(BackupTask(id: id, state: .pending, priority: .background))
        try await store.transition(id, to: .failedRetry, error: "network down")
        let row = try await store.find(id)
        XCTAssertEqual(row?.state, .failedRetry)
        XCTAssertEqual(row?.lastError, "network down")
    }

    func testTransitionClearsErrorOnSuccess() async throws {
        let store = try freshStore()
        let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
        try await store.upsert(BackupTask(id: id, state: .pending, priority: .background, lastError: "prior"))
        try await store.transition(id, to: .uploaded, error: nil)
        let row = try await store.find(id)
        XCTAssertEqual(row?.state, .uploaded)
        XCTAssertNil(row?.lastError)
    }

    func testFilterByState() async throws {
        let store = try freshStore()
        try await store.upsert(BackupTask(id: BackupTaskID(deviceId: "d", phassetLocalId: "A"),
                                          state: .pending, priority: .background))
        try await store.upsert(BackupTask(id: BackupTaskID(deviceId: "d", phassetLocalId: "B"),
                                          state: .uploaded, priority: .background))
        try await store.upsert(BackupTask(id: BackupTaskID(deviceId: "d", phassetLocalId: "C"),
                                          state: .pending, priority: .userEdit))
        let pending = try await store.tasks(in: .pending)
        XCTAssertEqual(pending.count, 2)
        XCTAssertEqual(Set(pending.map { $0.id.phassetLocalId }), ["A", "C"])
    }

    func testFindReturnsNilForMissing() async throws {
        let store = try freshStore()
        let row = try await store.find(BackupTaskID(deviceId: "d", phassetLocalId: "NOPE"))
        XCTAssertNil(row)
    }

    func testPersistsAcrossInstances() async throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("backup-state-persist-\(UUID().uuidString).sqlite")
        let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")
        do {
            let store = try BackupStateStore(databaseURL: url)
            try await store.upsert(BackupTask(id: id, state: .uploaded, priority: .background))
        }
        // Re-open with a fresh instance.
        let store2 = try BackupStateStore(databaseURL: url)
        let row = try await store2.find(id)
        XCTAssertEqual(row?.state, .uploaded)
    }
}
