// PanoMergeDismissGuardTests.swift — closing the merge view only asks for
// confirmation when it would lose a running or finished stitch (#5662).

import CoreGraphics
import XCTest
@testable import MapleCore

@MainActor
final class PanoMergeDismissGuardTests: XCTestCase {

    private let assets = (0..<3).map { AssetRef.preview(displayName: "IMG_\($0).dng") }

    private func waitUntil(_ condition: @MainActor () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition() {
            guard ContinuousClock.now < deadline else {
                return XCTFail("condition not met within 5 s", file: file, line: line)
            }
            try? await Task.sleep(for: .milliseconds(5))
        }
    }

    func testAFreshSessionClosesWithoutAsking() {
        let session = PanoMergeSession(stitcher: GatedStitcher(), previewDebounce: .seconds(60), availableMemory: { nil })

        XCTAssertFalse(session.closingDiscardsWork)
    }

    func testARunningStitchAsksBeforeClosing() async {
        let session = PanoMergeSession(stitcher: GatedStitcher(), previewDebounce: .seconds(60), availableMemory: { nil })

        session.start(assets: assets)
        await waitUntil { session.isRunning }

        XCTAssertTrue(session.closingDiscardsWork)
        session.cancel()
    }

    func testAFinishedPanoramaAsksBeforeClosing() async {
        let stitcher = GatedStitcher()
        stitcher.open()
        let session = PanoMergeSession(stitcher: stitcher, previewDebounce: .seconds(60), availableMemory: { nil })

        session.start(assets: assets)
        await waitUntil { if case .done = session.state { true } else { false } }

        XCTAssertTrue(session.closingDiscardsWork)
    }

    func testAFailedStitchClosesWithoutAsking() async {
        let stitcher = GatedStitcher()
        stitcher.open()
        stitcher.fails = true
        let session = PanoMergeSession(stitcher: stitcher, previewDebounce: .seconds(60), availableMemory: { nil })

        session.start(assets: assets)
        await waitUntil { if case .error = session.state { true } else { false } }

        XCTAssertFalse(session.closingDiscardsWork)
    }

    func testAStoppedStitchClosesWithoutAsking() async {
        let session = PanoMergeSession(stitcher: GatedStitcher(), previewDebounce: .seconds(60), availableMemory: { nil })
        session.start(assets: assets)
        await waitUntil { session.isRunning }

        session.cancel()

        XCTAssertFalse(session.closingDiscardsWork)
    }
}

private struct GatedFailure: Error {}

private final class GatedStitcher: PanoStitching, @unchecked Sendable {
    private let lock = NSLock()
    private var isOpen = false
    var fails = false

    func open() { lock.withLock { isOpen = true } }
    private var opened: Bool { lock.withLock { isOpen } }

    func cancel() {}

    func stitch(
        assets: [AssetRef],
        options: PanoOptions,
        alignment: PanoAlignment?,
        maxCanvasPixels: Int?,
        progress: @escaping @MainActor (PanoStage, Double) -> Void
    ) async throws -> PanoResult {
        while !opened, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(2))
        }
        try Task.checkCancellation()
        if fails { throw GatedFailure() }
        return PanoResult(
            outputURL: FileManager.default.temporaryDirectory.appendingPathComponent("gated.png"),
            reportSummary: "gated")
    }

    func preview(
        assets: [AssetRef],
        options: PanoOptions,
        alignment: PanoAlignment?,
        progress: @escaping @MainActor (PanoStage, Double) -> Void
    ) async throws -> PanoPreview {
        throw CancellationError()
    }
}
