// Tests/MapleBackupTests/InProcessBackupQueueTests.swift
import XCTest
@testable import MapleBackup

final class InProcessBackupQueueTests: XCTestCase {

    func testEnqueueAndDequeueInPriorityOrder() async throws {
        let q = InProcessBackupQueue()
        await q.enqueue(BackupTask(id: BackupTaskID(deviceId: "d", phassetLocalId: "low"),
                                   state: .pending, priority: .background),
                        priority: .background)
        await q.enqueue(BackupTask(id: BackupTaskID(deviceId: "d", phassetLocalId: "hi"),
                                   state: .pending, priority: .userEdit),
                        priority: .userEdit)
        let a = await q.dequeue()
        XCTAssertEqual(a?.id.phassetLocalId, "hi")
        let b = await q.dequeue()
        XCTAssertEqual(b?.id.phassetLocalId, "low")
        let c = await q.dequeue()
        XCTAssertNil(c)
    }

    func testFIFOWithinSamePriority() async throws {
        let q = InProcessBackupQueue()
        for name in ["A", "B", "C"] {
            await q.enqueue(BackupTask(id: BackupTaskID(deviceId: "d", phassetLocalId: name),
                                       state: .pending, priority: .background),
                            priority: .background)
        }
        let order = [
            await q.dequeue()?.id.phassetLocalId,
            await q.dequeue()?.id.phassetLocalId,
            await q.dequeue()?.id.phassetLocalId,
        ]
        XCTAssertEqual(order, ["A", "B", "C"])
    }

    func testCancelRemovesPendingTask() async throws {
        let q = InProcessBackupQueue()
        let id = BackupTaskID(deviceId: "d", phassetLocalId: "x")
        await q.enqueue(BackupTask(id: id, state: .pending, priority: .background),
                        priority: .background)
        await q.cancel(id)
        let next = await q.dequeue()
        XCTAssertNil(next)
    }

    func testSnapshot() async throws {
        let q = InProcessBackupQueue()
        await q.enqueue(BackupTask(id: BackupTaskID(deviceId: "d", phassetLocalId: "A"),
                                   state: .pending, priority: .background),
                        priority: .background)
        await q.enqueue(BackupTask(id: BackupTaskID(deviceId: "d", phassetLocalId: "B"),
                                   state: .pending, priority: .userEdit),
                        priority: .userEdit)
        let snap = await q.snapshot()
        XCTAssertEqual(snap.count, 2)
        // Snapshot ordering is the same as the dequeue order.
        XCTAssertEqual(snap.map { $0.id.phassetLocalId }, ["B", "A"])
    }

    func testObserveEmitsEnqueueEvent() async throws {
        let q = InProcessBackupQueue()
        let stream = await q.observe()
        var iterator = stream.makeAsyncIterator()
        Task {
            await q.enqueue(BackupTask(id: BackupTaskID(deviceId: "d", phassetLocalId: "y"),
                                       state: .pending, priority: .background),
                            priority: .background)
        }
        let event = await iterator.next()
        guard case .enqueued(let task) = event else {
            XCTFail("expected .enqueued event, got \(String(describing: event))")
            return
        }
        XCTAssertEqual(task.id.phassetLocalId, "y")
    }

    func testObserveEmitsCancelEvent() async throws {
        let q = InProcessBackupQueue()
        let id = BackupTaskID(deviceId: "d", phassetLocalId: "z")
        await q.enqueue(BackupTask(id: id, state: .pending, priority: .background),
                        priority: .background)
        let stream = await q.observe()
        var iterator = stream.makeAsyncIterator()
        Task {
            await q.cancel(id)
        }
        let event = await iterator.next()
        guard case .cancelled(let cancelledId) = event else {
            XCTFail("expected .cancelled event, got \(String(describing: event))")
            return
        }
        XCTAssertEqual(cancelledId, id)
    }
}

// MARK: - Newest-first within a priority (#3388)

final class InProcessBackupQueueCaptureOrderTests: XCTestCase {
    private func task(_ name: String, capturedAt: Date?, priority: BackupPriority = .background) -> BackupTask {
        BackupTask(id: BackupTaskID(deviceId: "d", phassetLocalId: name),
                   state: .pending, priority: priority, capturedAt: capturedAt)
    }

    private func drain(_ q: InProcessBackupQueue) async -> [String] {
        var out: [String] = []
        while let t = await q.dequeue() { out.append(t.id.phassetLocalId) }
        return out
    }

    func testNewerCaptureDequeuesFirstRegardlessOfEnqueueOrder() async throws {
        let q = InProcessBackupQueue()
        let base = Date(timeIntervalSince1970: 1_700_000_000)
        // Enqueued oldest → newest, i.e. the order a relaunch might rehydrate.
        await q.enqueue(task("old", capturedAt: base), priority: .background)
        await q.enqueue(task("mid", capturedAt: base.addingTimeInterval(60)), priority: .background)
        await q.enqueue(task("new", capturedAt: base.addingTimeInterval(120)), priority: .background)
        let order = await drain(q)
        XCTAssertEqual(order, ["new", "mid", "old"])
    }

    func testFreshCaptureJumpsAheadOfOlderBacklog() async throws {
        let q = InProcessBackupQueue()
        let base = Date(timeIntervalSince1970: 1_700_000_000)
        await q.enqueue(task("backlog-1", capturedAt: base.addingTimeInterval(-3600)), priority: .background)
        await q.enqueue(task("backlog-2", capturedAt: base.addingTimeInterval(-7200)), priority: .background)
        // Arrives mid-backlog with the newest date.
        await q.enqueue(task("just-shot", capturedAt: base), priority: .background)
        let first = await q.dequeue()
        XCTAssertEqual(first?.id.phassetLocalId, "just-shot")
    }

    func testUndatedTasksSortAfterDatedOnesThenFIFO() async throws {
        let q = InProcessBackupQueue()
        await q.enqueue(task("undated-a", capturedAt: nil), priority: .background)
        await q.enqueue(task("dated", capturedAt: Date(timeIntervalSince1970: 1)), priority: .background)
        await q.enqueue(task("undated-b", capturedAt: nil), priority: .background)
        let order = await drain(q)
        XCTAssertEqual(order, ["dated", "undated-a", "undated-b"])
    }

    func testPriorityStillOutranksCaptureDate() async throws {
        let q = InProcessBackupQueue()
        await q.enqueue(task("newest-background", capturedAt: Date(timeIntervalSince1970: 9_999_999)),
                        priority: .background)
        await q.enqueue(task("old-user-edit", capturedAt: Date(timeIntervalSince1970: 1), priority: .userEdit),
                        priority: .userEdit)
        let first = await q.dequeue()
        XCTAssertEqual(first?.id.phassetLocalId, "old-user-edit")
    }
}
