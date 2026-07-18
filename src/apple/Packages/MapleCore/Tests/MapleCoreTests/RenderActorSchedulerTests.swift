// RenderActorSchedulerTests.swift — slice 3 coverage (issue #194).
//
// Slice 3 moved the two-phase scheduler onto `RenderActor`:
//   • `scheduleRender(phase:work:)`  — cancels prior render+refine,
//     bumps generation, spawns render closure immediately.
//   • `scheduleRefine(work:)`         — cancels prior refine, debounces
//     150 ms, spawns refine closure. The "slider-drag coalescer".
//   • `currentGeneration()`           — render closures read this to
//     bail out when a newer schedule has superseded them.
//
// These tests verify the scheduling semantics independently of the
// MainActor EditSession publish layer:
//
//   1. Two consecutive `scheduleRender` calls cancel the first — the
//      first closure's `Task.isCancelled` flips true before it runs to
//      completion.
//   2. A flurry of `scheduleRefine` calls collapses to a single refine
//      execution — only the last one survives the 150 ms debounce.
//   3. The generation counter discards stale results — a render closure
//      that captured `gen=N` sees `currentGeneration() > N` after a
//      superseding schedule and bails out.
//
// Use the same actor-backed counter pattern as
// `EditSessionRefineCoalesceTests.DecodeCounter` — closure injection
// lets us count executions without standing up the real Rust pipeline.

import XCTest
import CoreImage
@testable import MapleCore

final class RenderActorSchedulerTests: XCTestCase {

    // MARK: - Helpers

    /// Spin up a `RenderActor` with the default pipeline. The pipeline
    /// is never called in these tests — the scheduler closures count
    /// invocations via the actor-backed counter pattern.
    private func makeActor() -> RenderActor {
        RenderActor(pipeline: ImageEditPipeline())
    }

    // MARK: - Cancel-previous

    /// Two consecutive `scheduleRender` calls must cancel the first.
    /// The first closure's `Task.isCancelled` flips true before its
    /// sleep completes; the counter records exactly one COMPLETED
    /// execution (the second). The first closure may have started but
    /// must observe cancellation and bail.
    func testTwoConsecutiveSchedulesCancelFirst() async {
        let actor = makeActor()
        let counter = ExecutionCounter()

        await actor.scheduleRender(phase: .fast) { _ in
            await counter.recordStart()
            // Sleep long enough that the second schedule lands before
            // we'd otherwise complete. Cancellation flips
            // `Task.isCancelled` to true inside this sleep so the
            // guard below trips.
            try? await Task.sleep(for: .milliseconds(200))
            if Task.isCancelled { return }
            await counter.recordComplete()
        }
        // Yield once so the first task actually starts before we
        // cancel it via the second schedule.
        try? await Task.sleep(for: .milliseconds(20))

        await actor.scheduleRender(phase: .fast) { _ in
            await counter.recordStart()
            // Short body so the second task completes first.
            if Task.isCancelled { return }
            await counter.recordComplete()
        }

        // Give both tasks time to settle.
        try? await Task.sleep(for: .milliseconds(400))

        let starts = await counter.startCount
        let completes = await counter.completeCount
        XCTAssertGreaterThanOrEqual(starts, 1, "at least the second schedule must start")
        XCTAssertEqual(completes, 1,
            "exactly one schedule must complete — the first was cancelled. starts=\(starts) completes=\(completes)")
    }

    // MARK: - Flurry coalesces

    /// During a slider-drag-style flurry of refine schedules, only the
    /// final one survives the 150 ms debounce. The earlier schedules
    /// are cancelled by the subsequent `scheduleRefine` calls before
    /// their debounce sleep ends.
    func testFlurryOnlyLastRefineExecutes() async {
        let actor = makeActor()
        let counter = ExecutionCounter()

        // Fire 10 refine schedules at ~20 ms intervals — a realistic
        // 60-Hz slider drag covering ~200 ms of continuous motion.
        // Total drag duration (200 ms) is comfortably longer than the
        // 150 ms debounce, so without cancel-previous semantics
        // multiple closures would slip through.
        for _ in 0..<10 {
            await actor.scheduleRefine { _ in
                await counter.recordComplete()
            }
            try? await Task.sleep(for: .milliseconds(20))
        }

        // Wait for the post-flurry debounce to land. 150 ms debounce
        // plus a generous margin.
        try? await Task.sleep(for: .milliseconds(300))

        let completes = await counter.completeCount
        XCTAssertEqual(completes, 1,
            "expected only the tail of the flurry to execute, got \(completes) completions")
    }

    /// A single `scheduleRefine` call does fire after the debounce.
    /// Sanity check that the coalescer doesn't accidentally cancel
    /// everything.
    func testSingleRefineExecutesAfterDebounce() async {
        let actor = makeActor()
        let counter = ExecutionCounter()

        await actor.scheduleRefine { _ in
            await counter.recordComplete()
        }

        // Before the debounce elapses the closure has not run.
        try? await Task.sleep(for: .milliseconds(50))
        let early = await counter.completeCount
        XCTAssertEqual(early, 0, "refine fired before debounce — \(early) early completion(s)")

        // After the debounce + margin it has.
        try? await Task.sleep(for: .milliseconds(200))
        let late = await counter.completeCount
        XCTAssertEqual(late, 1, "refine did not fire after debounce — got \(late) completion(s)")
    }

    // MARK: - Generation guard

    /// A render closure that captured `gen=N` must see
    /// `currentGeneration() > N` after a superseding schedule and bail
    /// out before publishing. This is the load-bearing invariant — it
    /// prevents stale Rust decode results from clobbering newer ones
    /// during a folder/image switch mid-render.
    func testGenerationGuardDropsStaleResults() async {
        let actor = makeActor()
        let publishCount = ExecutionCounter()

        // Schedule N — a long-running render that checks the
        // generation counter before publishing.
        await actor.scheduleRender(phase: .fast) { [actor, publishCount] gen in
            // Sleep so a superseding schedule can bump the counter.
            try? await Task.sleep(for: .milliseconds(150))
            let live = await actor.currentGeneration()
            // This is the guard that EditSession.decodeAndRender uses.
            if gen != live {
                // Stale — bail out without publishing.
                return
            }
            await publishCount.recordComplete()
        }
        // Yield so the first task starts.
        try? await Task.sleep(for: .milliseconds(20))

        // Schedule N+1 — supersedes the first. Its closure publishes.
        await actor.scheduleRender(phase: .fast) { [actor, publishCount] gen in
            let live = await actor.currentGeneration()
            if gen != live {
                return
            }
            await publishCount.recordComplete()
        }

        // Give both tasks time to finish their work.
        try? await Task.sleep(for: .milliseconds(400))

        let publishes = await publishCount.completeCount
        XCTAssertEqual(publishes, 1,
            "expected the stale (gen=N) closure to drop its result; got \(publishes) publishes")
    }

    /// `scheduleRefine` does NOT bump the generation counter — pan/zoom
    /// and window-resize refines must not invalidate the most recent
    /// fast publish. Verify by capturing the gen before/after.
    func testScheduleRefineDoesNotBumpGeneration() async {
        let actor = makeActor()

        await actor.scheduleRender(phase: .fast) { _ in /* no-op */ }
        let after1 = await actor.currentGeneration()

        await actor.scheduleRefine { _ in /* no-op */ }
        let after2 = await actor.currentGeneration()

        XCTAssertEqual(after1, after2,
            "scheduleRefine should not bump the generation counter (before=\(after1), after=\(after2))")
    }

    /// `scheduleRender` bumps the generation counter on every call.
    /// Verify monotonic increment.
    func testScheduleRenderBumpsGenerationMonotonically() async {
        let actor = makeActor()
        let g0 = await actor.currentGeneration()
        await actor.scheduleRender(phase: .fast) { _ in /* no-op */ }
        let g1 = await actor.currentGeneration()
        await actor.scheduleRender(phase: .fast) { _ in /* no-op */ }
        let g2 = await actor.currentGeneration()
        await actor.scheduleRender(phase: .refine) { _ in /* no-op */ }
        let g3 = await actor.currentGeneration()
        XCTAssertEqual(g1, g0 &+ 1)
        XCTAssertEqual(g2, g0 &+ 2)
        XCTAssertEqual(g3, g0 &+ 3)
    }

    // MARK: - awaitCurrentRenderIfInFlight (#2064 cold-open trigger coalescing)

    /// No render in flight ⇒ immediate return. This is what lets
    /// `kickRenderAfterGpuCanvasMount` behave exactly as before (unconditional
    /// kick) in the "mounted-after-completion" case #1362 was written for —
    /// the render that published via CPU has already settled by the time the
    /// layer registers, so there's nothing to wait on.
    func testAwaitCurrentRenderIfInFlightNoOpsWhenNothingRunning() async {
        let actor = makeActor()
        let start = ContinuousClock.now
        await actor.awaitCurrentRenderIfInFlight()
        let elapsed = start.duration(to: .now)
        XCTAssertLessThan(elapsed, .milliseconds(50),
            "must return immediately when no render is in flight")
    }

    /// The core #2064 contract: `awaitCurrentRenderIfInFlight` waits for the
    /// CURRENTLY in-flight render to finish rather than returning early, and
    /// — critically — does NOT cancel it. This is what a caller like
    /// `kickRenderAfterGpuCanvasMount` needs: instead of cancelling an
    /// in-flight fast-phase render (pure churn if it was already going to
    /// pick up the same fresh state) and re-scheduling, it can wait for the
    /// existing render to complete on its own terms and only re-schedule if,
    /// after that, its condition still isn't satisfied.
    func testAwaitCurrentRenderIfInFlightWaitsWithoutCancelling() async {
        let actor = makeActor()
        let counter = ExecutionCounter()

        await actor.scheduleRender(phase: .fast) { _ in
            await counter.recordStart()
            try? await Task.sleep(for: .milliseconds(150))
            if Task.isCancelled { return }
            await counter.recordComplete()
        }
        // Let the render actually start before we begin waiting on it.
        try? await Task.sleep(for: .milliseconds(20))

        let genBeforeWait = await actor.currentGeneration()
        await actor.awaitCurrentRenderIfInFlight()
        let genAfterWait = await actor.currentGeneration()

        XCTAssertEqual(genBeforeWait, genAfterWait,
            "awaiting must not itself schedule/cancel anything — generation must be unchanged")
        let completes = await counter.completeCount
        XCTAssertEqual(completes, 1,
            "the in-flight render must have been allowed to run to completion, not cancelled")
    }

    /// Simulates the actual `kickRenderAfterGpuCanvasMount` coalescing shape
    /// end to end at the RenderActor level (per the ticket's suggested test
    /// seam): a render is in flight; the "mount kick" waits for it instead of
    /// cancelling, and only issues a FRESH `scheduleRender` if the condition
    /// it cares about is still unmet afterward. Contrast with the OLD
    /// unconditional-kick behavior, which would have bumped the generation
    /// (and cancelled the in-flight render) immediately.
    func testMountKickShapeSkipsRedundantScheduleWhenConditionAlreadySatisfied() async {
        let actor = makeActor()
        let counter = ExecutionCounter()
        // Stand-in for `gpuFramePresented`: flips true partway through the
        // in-flight render, mirroring a render that picks up the
        // newly-registered layer on its own and presents via GPU.
        let presented = PresentFlag()

        await actor.scheduleRender(phase: .fast) { _ in
            await counter.recordStart()
            try? await Task.sleep(for: .milliseconds(80))
            if Task.isCancelled { return }
            await presented.set(true)
            await counter.recordComplete()
        }
        try? await Task.sleep(for: .milliseconds(20))
        let genAtMountEvent = await actor.currentGeneration()

        // The mount-kick shape: wait for the in-flight render, then only
        // schedule a fresh one if the condition is still unmet.
        await actor.awaitCurrentRenderIfInFlight()
        let stillUnmet = await !presented.value
        if stillUnmet {
            await actor.scheduleRender(phase: .fast) { _ in await counter.recordComplete() }
        }

        let genAfter = await actor.currentGeneration()
        XCTAssertEqual(genAfter, genAtMountEvent,
            "the render already in flight satisfied the condition on its own — no fresh schedule should have fired")
        let completes = await counter.completeCount
        XCTAssertEqual(completes, 1, "the original render must complete exactly once, uncancelled")
    }

    /// The narrow race the doc calls out: the in-flight render's own
    /// condition check already came back "unmet" (it committed to the CPU
    /// path before the layer registered) and never flips. The mount-kick
    /// shape must still schedule a FRESH render afterward — the mount is
    /// never silently dropped.
    func testMountKickShapeSchedulesFreshRenderWhenConditionStillUnmet() async {
        let actor = makeActor()
        let counter = ExecutionCounter()
        let presented = PresentFlag()

        await actor.scheduleRender(phase: .fast) { _ in
            await counter.recordStart()
            try? await Task.sleep(for: .milliseconds(50))
            if Task.isCancelled { return }
            // This render never satisfies the condition (e.g. it evaluated
            // `hasLayer == false` before this test's "mount" and fell back
            // to CPU) — `presented` stays false.
            await counter.recordComplete()
        }
        try? await Task.sleep(for: .milliseconds(15))
        let genAtMountEvent = await actor.currentGeneration()

        await actor.awaitCurrentRenderIfInFlight()
        let stillUnmet = await !presented.value
        XCTAssertTrue(stillUnmet, "test setup: the first render must not have satisfied the condition")
        if stillUnmet {
            await actor.scheduleRender(phase: .fast) { _ in
                await presented.set(true)
                await counter.recordComplete()
            }
        }

        try? await Task.sleep(for: .milliseconds(100))
        let genAfter = await actor.currentGeneration()
        XCTAssertGreaterThan(genAfter, genAtMountEvent,
            "the mount must still schedule a fresh render when nothing satisfied its condition")
        let completes = await counter.completeCount
        XCTAssertEqual(completes, 2, "both the original render and the fresh mount-kick render must complete")
        let finalPresented = await presented.value
        XCTAssertTrue(finalPresented, "the fresh render must have eventually satisfied the condition")
    }

    // MARK: - cancelAll

    /// `cancelAll` flips both task handles to a cancelled state so the
    /// debounced refine never fires after teardown.
    func testCancelAllStopsPendingRefine() async {
        let actor = makeActor()
        let counter = ExecutionCounter()

        await actor.scheduleRefine { _ in
            await counter.recordComplete()
        }
        // Cancel before the debounce elapses.
        try? await Task.sleep(for: .milliseconds(50))
        await actor.cancelAll()

        // Wait past the debounce window.
        try? await Task.sleep(for: .milliseconds(200))

        let completes = await counter.completeCount
        XCTAssertEqual(completes, 0,
            "cancelAll should have stopped the pending refine; got \(completes) completions")
    }

    // MARK: - Inline-await contract (production-shape regression guard)

    /// The render closure runs INLINE inside the actor's spawned task —
    /// no inner `Task { … }` chain. Production cancellation depends on
    /// this: if the closure body spawned a new Task and returned, the
    /// actor's `renderTask?.cancel()` against the (already-completed)
    /// outer handle would no-op while the inner task ran the full
    /// filter chain anyway.
    ///
    /// This test simulates the production shape — a closure that does
    /// an inline `await` of long-running work — and asserts that when
    /// a superseding schedule cancels the outer task, the inline await
    /// throws `CancellationError` (visible to the work) rather than
    /// running to completion.
    func testCancellationPropagatesIntoInlineAwait() async {
        let actor = makeActor()
        let observed = CancellationObserver()

        await actor.scheduleRender(phase: .fast) { _ in
            // Inline await — production shape. This is what
            // `EditSession._scheduleRender` does (it `await`s
            // `decodeAndRender` directly, not `Task { … }`).
            do {
                try await Task.sleep(for: .milliseconds(500))
                // If cancellation worked, we never reach here.
                await observed.recordCompletedWithoutCancellation()
            } catch {
                // Task.sleep throws on cancellation — the production
                // path's `Task.isCancelled` checks rely on the same
                // cooperative-cancellation chain.
                await observed.recordCancellationObserved()
            }
        }
        // Give the first task a moment to enter the sleep.
        try? await Task.sleep(for: .milliseconds(50))

        // Supersede — this cancels the first task's outer handle.
        await actor.scheduleRender(phase: .fast) { _ in
            // No-op — just bumping the generation + cancelling the prior.
        }

        // Wait long enough that, if cancellation FAILED to propagate,
        // the first task's 500 ms sleep would have completed.
        try? await Task.sleep(for: .milliseconds(700))

        let completed = await observed.completedWithoutCancellation
        let cancelled = await observed.cancellationObserved
        XCTAssertEqual(completed, 0,
            "the first closure must NOT have completed its sleep — cancellation failed to propagate (completed=\(completed), cancelled=\(cancelled))")
        XCTAssertGreaterThanOrEqual(cancelled, 1,
            "the first closure's inline `Task.sleep` must have thrown CancellationError — got cancelled=\(cancelled)")
    }
}

/// Observes whether the production-shape cancellation test saw a
/// `CancellationError` (good) or completed normally (bad).
private actor CancellationObserver {
    private var completed = 0
    private var cancelled = 0
    func recordCompletedWithoutCancellation() { completed += 1 }
    func recordCancellationObserved() { cancelled += 1 }
    var completedWithoutCancellation: Int { completed }
    var cancellationObserved: Int { cancelled }
}

/// Tiny actor-backed execution counter — same pattern as the
/// `DecodeCounter` used by `EditSessionRefineCoalesceTests`.
private actor ExecutionCounter {
    private var starts = 0
    private var completes = 0

    func recordStart() { starts += 1 }
    func recordComplete() { completes += 1 }

    var startCount: Int { starts }
    var completeCount: Int { completes }
}

/// Actor-backed boolean — stands in for `EditSession.gpuFramePresented` in
/// the #2064 mount-kick-shape tests above, which simulate the coalescing
/// logic at the RenderActor level without standing up a real GPU driver.
private actor PresentFlag {
    private(set) var value = false
    func set(_ newValue: Bool) { value = newValue }
}
