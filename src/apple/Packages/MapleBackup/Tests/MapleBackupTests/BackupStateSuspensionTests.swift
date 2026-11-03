import GRDB
import XCTest

@testable import MapleBackup

final class BackupStateSuspensionTests: XCTestCase {
  private let id = BackupTaskID(deviceId: "d", phassetLocalId: "P1")

  override func tearDown() {
    BackupStateSuspension.resume()
    super.tearDown()
  }

  private func freshStore() throws -> BackupStateStore {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("backup-state-\(UUID().uuidString).sqlite")
    return try BackupStateStore(databaseURL: url)
  }

  private func assertSuspended(
    _ operation: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line
  ) async {
    do {
      try await operation()
      XCTFail("a suspended store accepted the operation", file: file, line: line)
    } catch let error as DatabaseError {
      XCTAssertTrue(
        [.SQLITE_ABORT, .SQLITE_INTERRUPT].contains(error.resultCode),
        "unexpected \(error.resultCode)", file: file, line: line)
    } catch {
      XCTFail("unexpected \(error)", file: file, line: line)
    }
  }

  func testSuspendedStoreRefusesWritesAndLeavesTheRowUntouched() async throws {
    let store = try freshStore()
    try await store.upsert(BackupTask(id: id, state: .uploading, priority: .background))

    BackupStateSuspension.suspend()
    await assertSuspended { try await store.transition(id, to: .uploaded) }
    await assertSuspended {
      try await store.upsert(BackupTask(id: BackupTaskID(deviceId: "d", phassetLocalId: "P2"),
        state: .pending, priority: .background))
    }

    BackupStateSuspension.resume()
    let all = try await store.allTasks()
    XCTAssertEqual(all.map(\.id.phassetLocalId), ["P1"])
    XCTAssertEqual(all.first?.state, .uploading)
  }

  func testResumeRestoresWrites() async throws {
    let store = try freshStore()
    try await store.upsert(BackupTask(id: id, state: .pending, priority: .background))

    BackupStateSuspension.suspend()
    await assertSuspended { try await store.transition(id, to: .uploading) }
    BackupStateSuspension.resume()

    try await store.transition(id, to: .uploading)
    let row = try await store.find(id)
    XCTAssertEqual(row?.state, .uploading)
  }

  func testInterruptedUploadReturnsToPendingOnRehydrateWithoutLosingOrDuplicatingRows() async throws {
    let store = try freshStore()
    let other = BackupTaskID(deviceId: "d", phassetLocalId: "P2")
    try await store.upsert([
      BackupTask(id: id, state: .uploading, priority: .background),
      BackupTask(id: other, state: .pending, priority: .background),
    ])

    BackupStateSuspension.suspend()
    await assertSuspended { try await store.transition(id, to: .uploaded) }
    BackupStateSuspension.resume()

    let queue = InProcessBackupQueue()
    let enqueued = try await store.rehydrate(into: queue)
    let rows = try await store.allTasks().sorted { $0.id.phassetLocalId < $1.id.phassetLocalId }
    XCTAssertEqual(enqueued, 2)
    XCTAssertEqual(rows.map(\.id.phassetLocalId), ["P1", "P2"])
    XCTAssertEqual(rows.map(\.state), [.pending, .pending])
  }

  func testSuspendedStoreHoldsNoLockAgainstAnotherConnection() async throws {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("backup-state-\(UUID().uuidString).sqlite")
    let store = try BackupStateStore(databaseURL: url)
    try await store.upsert(BackupTask(id: id, state: .uploading, priority: .background))

    BackupStateSuspension.suspend()
    await assertSuspended { try await store.transition(id, to: .uploaded) }

    var configuration = Configuration()
    configuration.busyMode = .immediateError
    let other = try DatabaseQueue(path: url.path, configuration: configuration)
    try await other.write { db in
      try db.execute(sql: "UPDATE tasks SET retry_count = retry_count + 1")
    }
  }
}
