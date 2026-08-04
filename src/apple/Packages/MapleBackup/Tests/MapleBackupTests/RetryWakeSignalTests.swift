// Tests/MapleBackupTests/RetryWakeSignalTests.swift
//
// Direct unit coverage for the event-driven wakeup primitive (#1026),
// isolated from the rest of BackupEngine. The engine-level behavior (retry
// re-enqueue processed promptly, no fixed-interval wakeup, clean teardown,
// concurrent-run() safety) is covered by BackupEngineRetryWakeupTests in
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

        let finished = await awaitBounded(timeout: 0.5) { await signal.wait(); return true }
        XCTAssertNotNil(finished, "wait() should return immediately when a signal already landed")
    }

    /// The normal case: `wait()` parks, then a later `signal()` wakes it.
    func testWaitParksThenWakesOnSignal() async {
        let signal = RetryWakeSignal()
        let waiter = Task { await signal.wait() }

        // Give the waiter time to actually park before signaling — otherwise
        // this wouldn't exercise the "genuinely suspended" path.
        try? await Task.sleep(nanoseconds: 50_000_000)
        await signal.signal()

        let finished = await awaitBounded(timeout: 0.5) { await waiter.value; return true }
        XCTAssertNotNil(finished, "a parked wait() must wake once signal() is called")
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
        let finishedTooEarly = await awaitBounded(timeout: 0.15) { await signal.wait(); return true }
        XCTAssertNil(finishedTooEarly,
            "coalesced signals must not leave extra pending wakes behind")
    }

    /// Cancelling the waiting Task must resume `wait()` rather than leaking
    /// the parked continuation forever.
    func testCancellationWakesAParkedWaiter() async {
        let signal = RetryWakeSignal()
        let waiter = Task { await signal.wait() }
        try? await Task.sleep(nanoseconds: 50_000_000)
        waiter.cancel()

        let finished = await awaitBounded(timeout: 0.5) { await waiter.value; return true }
        XCTAssertNotNil(finished, "cancelling the waiter must not leak the parked continuation")
    }

    /// Finding 2 from PR #2477 review: cancellation must NOT cause a
    /// spurious wake on the *next* `wait()` call. `signal()` is awaited to
    /// completion before `cancel()` is called, so the continuation is
    /// deterministically already resumed (and nilled) by the time any
    /// cancellation handling runs — the cancellation path must find
    /// `continuation == nil` and no-op, not fall through to setting
    /// `pending = true`, which would make an unrelated later `wait()` return
    /// immediately for no reason.
    func testCancellationAfterRealSignalDoesNotCauseSpuriousWake() async {
        let signal = RetryWakeSignal()
        let waiter = Task { await signal.wait() }
        try? await Task.sleep(nanoseconds: 50_000_000) // let it genuinely park

        // The real signal wins first — awaited to completion, so `signal()`
        // has already resumed (and nilled) the continuation before the next
        // line runs.
        await signal.signal()
        waiter.cancel()

        let firstWaitFinished = await awaitBounded(timeout: 0.5) { await waiter.value; return true }
        XCTAssertNotNil(firstWaitFinished, "the waiter must complete despite the signal/cancel race")

        // A brand-new, unrelated wait() must genuinely park — no leftover
        // pending flag from the earlier signal/cancel sequence.
        let spuriousWake = await awaitBounded(timeout: 0.15) { await signal.wait(); return true }
        XCTAssertNil(spuriousWake,
            "a signal consumed by an earlier waiter must not leave a spurious pending wake for the next wait()")
    }
}
