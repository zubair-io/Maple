import SwiftUI
import XCTest
@testable import MapleUI

/// Tracks loader-closure calls across the `@Sendable` boundary the
/// controller's loader type requires.
private actor CallRecorder {
    private(set) var tiers: [MuiRemoteImageTier] = []
    private(set) var attempts = 0

    func record(_ tier: MuiRemoteImageTier) {
        tiers.append(tier)
    }

    func recordAttempt() -> Int {
        attempts += 1
        return attempts
    }
}

private func makeTestImage() -> Image {
    Image(systemName: "photo")
}

@MainActor
final class MuiRemoteImageControllerTests: XCTestCase {
    func testSingleTierLoadsAndPublishesThatTier() async {
        let tiers = MuiRemoteImageTiers(full: URL(string: "demo://full"))
        let controller = MuiRemoteImageController { _ in makeTestImage() }

        await controller.start(tiers: tiers)

        XCTAssertEqual(controller.tier, .full)
        XCTAssertNotNil(controller.image)
        XCTAssertFalse(controller.isLoading)
        XCTAssertFalse(controller.isError)
    }

    func testAllThreeTiersEndOnFullWithoutRegressingToAnEarlierTier() async {
        let tiers = MuiRemoteImageTiers(
            thumb: URL(string: "demo://thumb"),
            preview: URL(string: "demo://preview"),
            full: URL(string: "demo://full")
        )
        let recorder = CallRecorder()
        let controller = MuiRemoteImageController { url in
            let tier: MuiRemoteImageTier = url.absoluteString.contains("thumb") ? .thumb
                : url.absoluteString.contains("preview") ? .preview : .full
            await recorder.record(tier)
            return makeTestImage()
        }

        await controller.start(tiers: tiers)

        // Every tier resolved, in priority order, and the final published
        // tier is the sharpest one — never a regression back to a blurrier
        // tier once a sharper one has loaded (remote-image.md §States).
        let observedTiers = await recorder.tiers
        XCTAssertEqual(observedTiers, [.thumb, .preview, .full])
        XCTAssertEqual(controller.tier, .full)
        XCTAssertFalse(controller.isError)
    }

    func testAFailingTierIsSkippedNotFatal() async {
        let tiers = MuiRemoteImageTiers(thumb: URL(string: "demo://thumb"), full: URL(string: "demo://full"))
        let controller = MuiRemoteImageController { url in
            if url.absoluteString.contains("thumb") {
                throw MuiRemoteImageError.decodeFailed
            }
            return makeTestImage()
        }

        await controller.start(tiers: tiers)

        XCTAssertEqual(controller.tier, .full)
        XCTAssertFalse(controller.isError)
    }

    func testEveryTierFailingSetsError() async {
        let tiers = MuiRemoteImageTiers(thumb: URL(string: "demo://thumb"), full: URL(string: "demo://full"))
        let controller = MuiRemoteImageController { _ in throw MuiRemoteImageError.decodeFailed }

        await controller.start(tiers: tiers)

        XCTAssertTrue(controller.isError)
        XCTAssertNil(controller.image)
        XCTAssertNil(controller.tier)
        XCTAssertFalse(controller.isLoading)
    }

    func testRetryReRunsTheWholeSequenceAndClearsError() async {
        let tiers = MuiRemoteImageTiers(full: URL(string: "demo://full"))
        let recorder = CallRecorder()
        let controller = MuiRemoteImageController { _ in
            let attempt = await recorder.recordAttempt()
            if attempt == 1 { throw MuiRemoteImageError.decodeFailed }
            return makeTestImage()
        }

        await controller.start(tiers: tiers)
        XCTAssertTrue(controller.isError)

        await controller.retry()
        XCTAssertFalse(controller.isError)
        XCTAssertEqual(controller.tier, .full)
        let attempts = await recorder.attempts
        XCTAssertEqual(attempts, 2)
    }

    /// A `@StateObject`-owned controller is reused across SwiftUI view
    /// identity (List cells, record updates) with a *different* `tiers`
    /// value on every rebind — `start(tiers:)` must not keep showing the
    /// previous call's error/image, it must reset and load the new tiers
    /// (the bug `MuiRemoteImage`'s `.task(id:)` fix addresses).
    func testStartWithDifferentTiersResetsStateAndLoadsTheNewTiers() async {
        let failingTiers = MuiRemoteImageTiers(full: URL(string: "demo://broken"))
        let succeedingTiers = MuiRemoteImageTiers(full: URL(string: "demo://ok"))
        let controller = MuiRemoteImageController { url in
            if url.absoluteString.contains("broken") {
                throw MuiRemoteImageError.decodeFailed
            }
            return makeTestImage()
        }

        await controller.start(tiers: failingTiers)
        XCTAssertTrue(controller.isError)
        XCTAssertNil(controller.image)

        // Simulate the reused-view case: a second `start(tiers:)` call on
        // the SAME controller instance with a different `tiers` value.
        await controller.start(tiers: succeedingTiers)

        XCTAssertFalse(controller.isError)
        XCTAssertEqual(controller.tier, .full)
        XCTAssertNotNil(controller.image)
    }

    /// Cancelling the driving `Task` mid-sequence must neither run the
    /// remaining tiers' loaders nor fall through to publish `isError`
    /// (that would flash an error overlay for a load nobody is waiting on
    /// any more — e.g. a `List` cell scrolled off-screen).
    func testCancellationStopsTheTierLoopAndLeavesIsErrorFalse() async {
        let tiers = MuiRemoteImageTiers(
            thumb: URL(string: "demo://thumb"),
            full: URL(string: "demo://full")
        )
        let recorder = CallRecorder()
        let controller = MuiRemoteImageController { url in
            let observedTier: MuiRemoteImageTier = url.absoluteString.contains("thumb") ? .thumb : .full
            await recorder.record(observedTier)
            if observedTier == .thumb {
                // Hold the thumb tier in flight until the test cancels the
                // driving task, then fail it — exercising the loop guard
                // that must stop before ever calling the full tier's loader.
                while !Task.isCancelled { await Task.yield() }
                throw MuiRemoteImageError.decodeFailed
            }
            return makeTestImage()
        }

        let task = Task { await controller.start(tiers: tiers) }
        while await recorder.tiers.isEmpty { await Task.yield() }
        task.cancel()
        await task.value

        let observedTiers = await recorder.tiers
        XCTAssertEqual(observedTiers, [.thumb], "the full tier's loader must never run once the driving task is cancelled")
        XCTAssertFalse(controller.isError)
        XCTAssertNil(controller.image)
    }
}
