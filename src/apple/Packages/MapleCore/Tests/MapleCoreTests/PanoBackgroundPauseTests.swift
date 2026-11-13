// PanoBackgroundPauseTests.swift — a stitch holds the host's backup pause while
// it runs and lets go on every way it can end (#5653).

import Foundation
import XCTest
import os

@testable import MapleCore

private actor CountingPauser: PanoBackgroundPausing {
    private(set) var active = 0
    private(set) var peak = 0
    private(set) var acquired = 0
    private let stoppedRunningWork: Bool
    private var gate: CheckedContinuation<Void, Never>?
    private var gated: Bool

    init(stoppedRunningWork: Bool = true, gated: Bool = false) {
        self.stoppedRunningWork = stoppedRunningWork
        self.gated = gated
    }

    func open() {
        gated = false
        gate?.resume()
        gate = nil
    }

    func pause() async -> PanoBackgroundPause {
        if gated { await withCheckedContinuation { gate = $0 } }
        active += 1
        acquired += 1
        peak = max(peak, active)
        return PanoBackgroundPause(stoppedRunningWork: stoppedRunningWork) { [weak self] in
            Task { await self?.released() }
        }
    }

    private func released() { active -= 1 }
}

private final class ScriptedStitcher: PanoStitching, @unchecked Sendable {
    enum Ending { case succeed, fail, hold }

    private let inner = RecordingStitcher()
    private let ending: Ending
    private let inDevice: Bool
    private let stitches = OSAllocatedUnfairLock(initialState: 0)

    init(ending: Ending, inDevice: Bool = true, sizes: PanoStitchSizes? = nil) {
        self.ending = ending
        self.inDevice = inDevice
        MainActor.assumeIsolated { inner.previewSizes = sizes }
    }

    var runsInDeviceMemory: Bool { inDevice }
    var stitchCount: Int { stitches.withLock { $0 } }
    @MainActor var caps: [Int?] { inner.stitchCaps }

    func cancel() {}

    func preview(
        assets: [AssetRef], options: PanoOptions, alignment: PanoAlignment?,
        progress: @escaping @MainActor (PanoStage, Double) -> Void
    ) async throws -> PanoPreview {
        try await inner.preview(assets: assets, options: options, alignment: alignment, progress: progress)
    }

    func stitch(
        assets: [AssetRef], options: PanoOptions, alignment: PanoAlignment?,
        maxCanvasPixels: Int?, progress: @escaping @MainActor (PanoStage, Double) -> Void
    ) async throws -> PanoResult {
        stitches.withLock { $0 += 1 }
        switch ending {
        case .succeed:
            return try await inner.stitch(
                assets: assets, options: options, alignment: alignment,
                maxCanvasPixels: maxCanvasPixels, progress: progress)
        case .fail:
            throw URLError(.cannotWriteToFile)
        case .hold:
            _ = try await inner.stitch(
                assets: assets, options: options, alignment: alignment,
                maxCanvasPixels: maxCanvasPixels, progress: progress)
            try await Task.sleep(for: .seconds(60))
            throw CancellationError()
        }
    }
}

@MainActor
final class PanoBackgroundPauseTests: XCTestCase {
    private let assets = (0..<3).map { AssetRef.preview(displayName: "IMG_\($0).dng") }
    private let pano01 = PanoStitchSizes(
        canvasWidth: 26_981, canvasHeight: 9_488, largestFramePixels: 20_813_856, frameCount: 21, scratchBytes: 0)

    private func eventually(_ condition: () async -> Bool) async {
        let deadline = ContinuousClock.now + .seconds(5)
        while ContinuousClock.now < deadline {
            if await condition() { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("condition not met in time")
    }

    private func makeSession(
        _ stitcher: ScriptedStitcher, pauser: CountingPauser,
        availableMemory: @escaping @Sendable () -> Int? = { nil }
    ) -> PanoMergeSession {
        PanoMergeSession(
            stitcher: stitcher, previewDebounce: .milliseconds(5), availableMemory: availableMemory,
            isPhone: true, freeSpace: { _, _ in nil }, backgroundPause: pauser)
    }

    private func isDone(_ session: PanoMergeSession) -> Bool {
        if case .done = session.state { return true }
        return false
    }

    private func hasFailed(_ session: PanoMergeSession) -> Bool {
        if case .error = session.state { return true }
        return false
    }

    func testPauseIsHeldWhileTheStitchRunsAndReleasedOnSuccess() async {
        let pauser = CountingPauser()
        let session = makeSession(ScriptedStitcher(ending: .succeed), pauser: pauser)
        session.start(assets: assets)
        await eventually { self.isDone(session) }
        await eventually { await pauser.active == 0 }
        let acquired = await pauser.acquired
        XCTAssertEqual(acquired, 1)
    }

    func testPauseIsReleasedWhenTheStitchFails() async {
        let pauser = CountingPauser()
        let session = makeSession(ScriptedStitcher(ending: .fail), pauser: pauser)
        session.start(assets: assets)
        await eventually { self.hasFailed(session) }
        await eventually { await pauser.active == 0 }
        let acquired = await pauser.acquired
        XCTAssertEqual(acquired, 1)
    }

    func testPauseIsHeldMidStitchAndReleasedWhenTheUserCancels() async {
        let pauser = CountingPauser()
        let stitcher = ScriptedStitcher(ending: .hold)
        let session = makeSession(stitcher, pauser: pauser)
        session.start(assets: assets)
        await eventually { stitcher.stitchCount == 1 }
        let heldWhileStitching = await pauser.active
        XCTAssertEqual(heldWhileStitching, 1)

        session.cancel()
        await eventually { await pauser.active == 0 }
    }

    func testCancelWhileThePauseIsStillBeingAcquiredNeverStitchesAndReleases() async {
        let pauser = CountingPauser(gated: true)
        let stitcher = ScriptedStitcher(ending: .succeed)
        let session = makeSession(stitcher, pauser: pauser)
        session.start(assets: assets)
        try? await Task.sleep(for: .milliseconds(30))
        session.cancel()
        await pauser.open()

        await eventually { await pauser.acquired == 1 }
        await eventually { await pauser.active == 0 }
        XCTAssertEqual(stitcher.stitchCount, 0)
    }

    func testARestartedStitchReleasesTheFirstPauseBeforeTakingTheNext() async {
        let pauser = CountingPauser()
        let stitcher = ScriptedStitcher(ending: .hold)
        let session = makeSession(stitcher, pauser: pauser)
        session.start(assets: assets)
        await eventually { stitcher.stitchCount == 1 }

        session.start(assets: assets)
        await eventually { stitcher.stitchCount == 2 }
        let peak = await pauser.peak
        XCTAssertEqual(peak, 1)

        session.cancel()
        await eventually { await pauser.active == 0 }
    }

    func testAStitchThatOutlivesItsWindowStillReleasesWhenItEnds() async {
        let pauser = CountingPauser()
        let stitcher = ScriptedStitcher(ending: .hold)
        weak var weakSession: PanoMergeSession?
        do {
            let session = makeSession(stitcher, pauser: pauser)
            weakSession = session
            session.start(assets: assets)
            await eventually { stitcher.stitchCount == 1 }
            session.cancel()
        }
        await eventually { await pauser.active == 0 }
        await eventually { weakSession == nil }
    }

    func testAPauseDroppedWithoutReleaseIsReleasedOnDeinit() {
        let releases = OSAllocatedUnfairLock(initialState: 0)
        do {
            _ = PanoBackgroundPause(stoppedRunningWork: true) { releases.withLock { $0 += 1 } }
        }
        XCTAssertEqual(releases.withLock { $0 }, 1)
    }

    func testReleasingTwiceRunsTheHostReleaseOnce() {
        let releases = OSAllocatedUnfairLock(initialState: 0)
        let pause = PanoBackgroundPause(stoppedRunningWork: false) { releases.withLock { $0 += 1 } }
        pause.release()
        pause.release()
        XCTAssertEqual(releases.withLock { $0 }, 1)
    }

    func testAStitchOnTheServerNeverPausesTheDevice() async {
        let pauser = CountingPauser()
        let session = makeSession(ScriptedStitcher(ending: .succeed, inDevice: false), pauser: pauser)
        session.start(assets: assets)
        await eventually { self.isDone(session) }
        let acquired = await pauser.acquired
        XCTAssertEqual(acquired, 0)
    }

    private func settledPhoneSession(
        pauser: CountingPauser, available: OSAllocatedUnfairLock<Int>, stitcher: ScriptedStitcher
    ) async -> PanoMergeSession {
        let session = makeSession(stitcher, pauser: pauser, availableMemory: { available.withLock { $0 } })
        session.preview(assets: assets)
        await eventually { session.lastPreview != nil }
        return session
    }

    private var fullPeakOverSeventyPercent: Int {
        Int(Double(PanoMemoryModel().estimatedPeakBytes(sizes: pano01, canvasWidth: pano01.canvasWidth)) / 0.7)
    }

    func testStoppingTheBackupRefreshesTheDefaultOutputSizeBeforeTheStitch() async {
        let tight = fullPeakOverSeventyPercent
        let roomy = tight * 2
        let available = OSAllocatedUnfairLock(initialState: tight)
        let pauser = CountingPauser()
        let stitcher = ScriptedStitcher(ending: .succeed, sizes: pano01)
        let session = await settledPhoneSession(pauser: pauser, available: available, stitcher: stitcher)
        XCTAssertEqual(session.outputSize, .fitted)

        available.withLock { $0 = roomy }
        session.start(assets: assets)
        await eventually { self.isDone(session) }

        XCTAssertEqual(stitcher.caps, [nil])
    }

    func testAPauseThatStoppedNothingLeavesTheFitAlone() async {
        let tight = fullPeakOverSeventyPercent
        let roomy = tight * 2
        let available = OSAllocatedUnfairLock(initialState: tight)
        let pauser = CountingPauser(stoppedRunningWork: false)
        let stitcher = ScriptedStitcher(ending: .succeed, sizes: pano01)
        let session = await settledPhoneSession(pauser: pauser, available: available, stitcher: stitcher)
        let fittedPixels = session.fittedOutput?.pixels

        available.withLock { $0 = roomy }
        session.start(assets: assets)
        await eventually { self.isDone(session) }

        XCTAssertEqual(stitcher.caps, [fittedPixels])
    }

    func testAnExplicitSmallerChoiceStandsAfterTheBackupStops() async {
        let tight = fullPeakOverSeventyPercent
        let roomy = tight * 2
        let available = OSAllocatedUnfairLock(initialState: tight)
        let pauser = CountingPauser()
        let stitcher = ScriptedStitcher(ending: .succeed, sizes: pano01)
        let session = await settledPhoneSession(pauser: pauser, available: available, stitcher: stitcher)
        session.outputSize = .fitted
        let fittedPixels = session.fittedOutput?.pixels

        available.withLock { $0 = roomy }
        session.start(assets: assets)
        await eventually { self.isDone(session) }

        XCTAssertEqual(stitcher.caps, [fittedPixels])
    }
}
