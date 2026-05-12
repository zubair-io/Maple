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
