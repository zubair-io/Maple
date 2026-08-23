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
        let controller = MuiRemoteImageController(tiers: tiers) { _ in makeTestImage() }

        await controller.start()

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
        let controller = MuiRemoteImageController(tiers: tiers) { url in
            let tier: MuiRemoteImageTier = url.absoluteString.contains("thumb") ? .thumb
                : url.absoluteString.contains("preview") ? .preview : .full
            await recorder.record(tier)
            return makeTestImage()
        }

        await controller.start()

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
        let controller = MuiRemoteImageController(tiers: tiers) { url in
            if url.absoluteString.contains("thumb") {
                throw MuiRemoteImageError.decodeFailed
            }
            return makeTestImage()
        }

        await controller.start()

        XCTAssertEqual(controller.tier, .full)
        XCTAssertFalse(controller.isError)
    }

    func testEveryTierFailingSetsError() async {
        let tiers = MuiRemoteImageTiers(thumb: URL(string: "demo://thumb"), full: URL(string: "demo://full"))
        let controller = MuiRemoteImageController(tiers: tiers) { _ in throw MuiRemoteImageError.decodeFailed }

        await controller.start()

        XCTAssertTrue(controller.isError)
        XCTAssertNil(controller.image)
        XCTAssertNil(controller.tier)
        XCTAssertFalse(controller.isLoading)
    }

    func testRetryReRunsTheWholeSequenceAndClearsError() async {
        let tiers = MuiRemoteImageTiers(full: URL(string: "demo://full"))
        let recorder = CallRecorder()
        let controller = MuiRemoteImageController(tiers: tiers) { _ in
            let attempt = await recorder.recordAttempt()
            if attempt == 1 { throw MuiRemoteImageError.decodeFailed }
            return makeTestImage()
        }

        await controller.start()
        XCTAssertTrue(controller.isError)

        await controller.retry()
        XCTAssertFalse(controller.isError)
        XCTAssertEqual(controller.tier, .full)
        let attempts = await recorder.attempts
        XCTAssertEqual(attempts, 2)
    }
}
