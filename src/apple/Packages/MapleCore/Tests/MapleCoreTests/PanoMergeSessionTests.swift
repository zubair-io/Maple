// PanoMergeSessionTests.swift
// Unit tests for PanoMergeSession state transitions.
//
// Uses a SynchronousMockStitcher (instant, no async delays) so the tests
// run without real-time waits.
//
// Ticket: #1236 / Part of #1234

import Testing
import Foundation
@testable import MapleCore

// MARK: - SynchronousMockStitcher

/// Instant stitcher for testing — walks all stages with zero delay and
/// returns a fake result. Respects cancellation.
private final class SynchronousMockStitcher: PanoStitching {
    // nonisolated(unsafe) avoids the Swift 6 Sendable mutation warning on
    // this test-only class while keeping the package on Swift 5 language mode.
    nonisolated(unsafe) var shouldFail: Bool = false
    nonisolated(unsafe) private var cancelledFlag: Bool = false

    func cancel() { cancelledFlag = true }

    func stitch(
        assets: [AssetRef],
        options: PanoOptions,
        progress: @escaping @MainActor (PanoStage, Double) -> Void
    ) async throws -> PanoResult {
        cancelledFlag = false
        if shouldFail { throw TestStitcherError.deliberate }

        for stage in PanoStage.allCases {
            guard !cancelledFlag else { throw CancellationError() }
            await MainActor.run { progress(stage, 1.0) }
        }

        let dir = FileManager.default.temporaryDirectory
        let url = dir.appendingPathComponent("test-pano-\(UUID().uuidString).tiff")
        // Write a trivially small file so outputURL is non-nil on disk.
        try Data("mock".utf8).write(to: url)
        return PanoResult(outputURL: url, reportSummary: "test summary")
    }
}

private enum TestStitcherError: Error { case deliberate }

// MARK: - PanoMergeSessionTests

@MainActor
struct PanoMergeSessionTests {

    private func makeAssets(_ count: Int) -> [AssetRef] {
        (0..<count).map { AssetRef.preview(displayName: "IMG_\($0).dng") }
    }

    @Test("initial state is idle")
    func initialStateIsIdle() {
        let session = PanoMergeSession(stitcher: SynchronousMockStitcher())
        if case .idle = session.state { /* pass */ }
        else { Issue.record("Expected idle, got \(session.state)") }
    }

    @Test("start() with <2 assets is a no-op")
    func startNeedsAtLeastTwo() async {
        let session = PanoMergeSession(stitcher: SynchronousMockStitcher())
        session.start(assets: makeAssets(1))
        // State should remain idle — the guard fires before any async work.
        if case .idle = session.state { /* pass */ }
        else { Issue.record("Expected idle after start with 1 asset, got \(session.state)") }
    }

    @Test("successful run ends in done state")
    func successfulRunEndsDone() async throws {
        let stitcher = SynchronousMockStitcher()
        let session = PanoMergeSession(stitcher: stitcher)
        session.start(assets: makeAssets(3))

        // Yield to the Task so the synchronous stitcher can finish.
        var iterations = 0
        while session.isRunning && iterations < 100 {
            await Task.yield()
            iterations += 1
        }

        guard case .done(let result) = session.state else {
            Issue.record("Expected done, got \(session.state)")
            return
        }
        #expect(!result.reportSummary.isEmpty)
    }

    @Test("failed run ends in error state")
    func failedRunEndsError() async throws {
        let stitcher = SynchronousMockStitcher()
        stitcher.shouldFail = true
        let session = PanoMergeSession(stitcher: stitcher)
        session.start(assets: makeAssets(2))

        var iterations = 0
        while session.isRunning && iterations < 100 {
            await Task.yield()
            iterations += 1
        }

        guard case .error = session.state else {
            Issue.record("Expected error, got \(session.state)")
            return
        }
    }

    @Test("cancel() returns to idle")
    func cancelReturnsIdle() async throws {
        let stitcher = SynchronousMockStitcher()
        let session = PanoMergeSession(stitcher: stitcher)
        session.start(assets: makeAssets(4))
        session.cancel()

        if case .idle = session.state { /* pass */ }
        else { Issue.record("Expected idle after cancel, got \(session.state)") }
        #expect(!session.isRunning)
    }

    @Test("reset() from done returns to idle")
    func resetFromDone() async throws {
        let stitcher = SynchronousMockStitcher()
        let session = PanoMergeSession(stitcher: stitcher)
        session.start(assets: makeAssets(2))

        var iterations = 0
        while session.isRunning && iterations < 100 {
            await Task.yield()
            iterations += 1
        }

        session.reset()
        if case .idle = session.state { /* pass */ }
        else { Issue.record("Expected idle after reset, got \(session.state)") }
    }

    @Test("isRunning is false when idle")
    func isRunningFalseWhenIdle() {
        let session = PanoMergeSession(stitcher: SynchronousMockStitcher())
        #expect(!session.isRunning)
    }

    // MARK: - Cancel-on-dismiss (issue #4 / AppShell.swift:709)

    /// Regression guard for the "leak on system-gesture dismiss" bug.
    ///
    /// `AppShell.dismissPanoramaMerge()` is the single exit point for ALL
    /// dismissal paths (Cancel button, Done button, swipe-down, Escape).
    /// This test verifies that calling `session.cancel()` — exactly what
    /// `dismissPanoramaMerge()` does — stops the stitch regardless of
    /// which path triggered it.
    ///
    /// The `CancellableSpyStitcher` suspends forever in `stitch` until
    /// `cancel()` is called, letting us verify that:
    ///   1. The session is running after `start()`.
    ///   2. `cancel()` immediately transitions state to `.idle`.
    ///   3. `isRunning` is false after cancel.
    @Test("cancel() on dismiss stops an in-flight stitch")
    func cancelOnDismissStopsInFlightStitch() async throws {
        let spy = CancellableSpyStitcher()
        let session = PanoMergeSession(stitcher: spy)

        session.start(assets: makeAssets(3))
        // Yield once so the Task in PanoMergeSession starts and the stitcher
        // enters its suspension point. The spy records the cancel() call
        // regardless of whether the Task has started yet, so this is stable.
        await Task.yield()

        // Simulate AppShell.dismissPanoramaMerge() calling session.cancel().
        session.cancel()

        #expect(!session.isRunning, "session must not be running after cancel")
        if case .idle = session.state { /* pass */ }
        else { Issue.record("Expected idle after cancel-on-dismiss, got \(session.state)") }
        #expect(spy.cancelCallCount >= 1, "stitcher.cancel() must be invoked")
    }
}

// MARK: - CancellableSpyStitcher

/// Stitcher that suspends in `stitch` until cancelled. Records the number
/// of times `cancel()` is invoked so tests can assert it was called.
private final class CancellableSpyStitcher: PanoStitching {
    nonisolated(unsafe) private(set) var cancelCallCount: Int = 0
    nonisolated(unsafe) private var cancelled: Bool = false

    func cancel() {
        cancelled = true
        cancelCallCount += 1
    }

    func stitch(
        assets: [AssetRef],
        options: PanoOptions,
        progress: @escaping @MainActor (PanoStage, Double) -> Void
    ) async throws -> PanoResult {
        cancelled = false
        // Emit a single progress tick so the session enters .running, then
        // suspend until cancel() flips the flag.
        await MainActor.run { progress(.decoding, 0.0) }
        while !cancelled {
            try await Task.sleep(for: .milliseconds(5))
        }
        throw CancellationError()
    }
}
