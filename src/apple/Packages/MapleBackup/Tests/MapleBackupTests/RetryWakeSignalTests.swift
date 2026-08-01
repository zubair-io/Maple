// Tests/MapleBackupTests/RetryWakeSignalTests.swift
//
// Direct unit coverage for the event-driven wakeup primitive (#1026),
// isolated from the rest of BackupEngine. The engine-level behavior (retry
// re-enqueue processed promptly, no fixed-interval wakeup, clean teardown)
// is covered by BackupEngineRetryWakeupTests in
// BackupEngineConcurrencyTests.swift; these tests pin down the primitive's
// own race-freedom and cancellation contract.
import XCTest
@testable import MapleBackup

final class RetryWakeSignalTests: XCTestCase {

    /// A `wait()` call that starts after `signal()` already fired must not
    /// suspend at all — otherwise a signal that arrives while the caller is
    /// still busy (not yet parked) would be lost.
    func testSignalBeforeWaitIsNotLost() async {
        let signal = RetryWakeSignal()
        await signal.signal()

        // If the pending flag weren't honored this would hang; the test
        // harness's own timeout is the backstop, but bound it explicitly so
        // a regression fails fast instead of stalling the suite.
        let finished = await withTaskGroup(of: Bool.self) { group -> Bool in
            group.addTask { await signal.wait(); return true }
            group.addTask {
                try? await Task.sleep(nanoseconds: 500_000_000)
                return false
            }
            let first = await group.next() ?? false
            group.cancelAll()
            return first
        }
        XCTAssertTrue(finished, "wait() should return immediately when a signal already landed")
    }

    /// The normal case: `wait()` parks, then a later `signal()` wakes it.
    func testWaitParksThenWakesOnSignal() async {
        let signal = RetryWakeSignal()
        let waiter = Task { await signal.wait() }

        // Give the waiter time to actually park before signaling — otherwise
        // this wouldn't exercise the "genuinely suspended" path.
        try? await Task.sleep(nanoseconds: 50_000_000)
        await signal.signal()

        // Waiter must complete promptly once signaled.
        let finished = await withTaskGroup(of: Bool.self) { group -> Bool in
            group.addTask { await waiter.value; return true }
            group.addTask {
                try? await Task.sleep(nanoseconds: 500_000_000)
                return false
            }
            let first = await group.next() ?? false
            group.cancelAll()
            return first
        }
        XCTAssertTrue(finished, "a parked wait() must wake once signal() is called")
    }

    /// Multiple signals before anyone waits coalesce into a single pending
    /// wake — bounded buffering, not a queue of N wakes for N waits.
    func testMultipleSignalsCoalesceIntoOnePendingWake() async {
        let signal = RetryWakeSignal()
        await signal.signal()
        await signal.signal()
        await signal.signal()

        // First wait consumes the coalesced pending flag immediately.
        await signal.wait()

        // A second wait must genuinely park now — nothing left pending —
        // so a bounded 150ms timeout should observe no completion.
        let finishedTooEarly = await withTaskGroup(of: Bool.self) { group -> Bool in
            group.addTask { await signal.wait(); return true }
            group.addTask {
                try? await Task.sleep(nanoseconds: 150_000_000)
                return false
            }
            let first = await group.next() ?? false
            group.cancelAll()
            return first
        }
        XCTAssertFalse(finishedTooEarly,
            "coalesced signals must not leave extra pending wakes behind")
    }

    /// Cancelling the waiting Task must resume `wait()` rather than leaking
    /// the parked continuation forever.
    func testCancellationWakesAParkedWaiter() async {
        let signal = RetryWakeSignal()
        let waiter = Task { await signal.wait() }
        try? await Task.sleep(nanoseconds: 50_000_000)
        waiter.cancel()

        let finished = await withTaskGroup(of: Bool.self) { group -> Bool in
            group.addTask { await waiter.value; return true }
            group.addTask {
                try? await Task.sleep(nanoseconds: 500_000_000)
                return false
            }
            let first = await group.next() ?? false
            group.cancelAll()
            return first
        }
        XCTAssertTrue(finished, "cancelling the waiter must not leak the parked continuation")
    }
}
