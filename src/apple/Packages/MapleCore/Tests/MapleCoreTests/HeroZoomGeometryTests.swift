// HeroZoomGeometryTests.swift — #1489.
//
// Pure-function coverage for the zoom-to-open transition's geometry: the
// fit rect the flying thumbnail has to land on, the rect/scalar lerps that
// drive it there, the trailing ramp the editor chrome rides, and the
// pinch-in → close-progress mapping that makes the interactive close the
// open animation played backwards. No SwiftUI, no MainActor.

import XCTest
import CoreGraphics
@testable import MapleCore

final class HeroZoomGeometryTests: XCTestCase {

    // MARK: - fitRect

    /// A 3:2 image in a taller-than-wide container pillarboxes: it spans the
    /// full width and is vertically centred.
    func testFitRectPillarboxesInTallContainer() {
        let rect = HeroZoomGeometry.fitRect(
            aspectRatio: 3.0 / 2.0,
            in: CGSize(width: 300, height: 400)
        )
        XCTAssertEqual(rect.width, 300, accuracy: 1e-9)
        XCTAssertEqual(rect.height, 200, accuracy: 1e-9)
        XCTAssertEqual(rect.minX, 0, accuracy: 1e-9)
        XCTAssertEqual(rect.minY, 100, accuracy: 1e-9)
    }

    /// A 3:2 image in a wider-than-that container letterboxes on the sides:
    /// full height, horizontally centred.
    func testFitRectLetterboxesInWideContainer() {
        let rect = HeroZoomGeometry.fitRect(
            aspectRatio: 3.0 / 2.0,
            in: CGSize(width: 900, height: 400)
        )
        XCTAssertEqual(rect.width, 600, accuracy: 1e-9)
        XCTAssertEqual(rect.height, 400, accuracy: 1e-9)
        XCTAssertEqual(rect.minX, 150, accuracy: 1e-9)
        XCTAssertEqual(rect.minY, 0, accuracy: 1e-9)
    }

    /// Matching aspects fill the container exactly — no inset on either axis.
    func testFitRectMatchingAspectFillsContainer() {
        let rect = HeroZoomGeometry.fitRect(
            aspectRatio: 2.0,
            in: CGSize(width: 800, height: 400)
        )
        XCTAssertEqual(rect, CGRect(x: 0, y: 0, width: 800, height: 400))
    }

    /// Degenerate inputs fall back to the container rect rather than
    /// producing NaN geometry the presentation would animate into.
    func testFitRectDegenerateInputsFallBackToContainer() {
        let size = CGSize(width: 320, height: 240)
        let expected = CGRect(origin: .zero, size: size)
        XCTAssertEqual(HeroZoomGeometry.fitRect(aspectRatio: 0, in: size), expected)
        XCTAssertEqual(HeroZoomGeometry.fitRect(aspectRatio: -1.5, in: size), expected)
        XCTAssertEqual(HeroZoomGeometry.fitRect(aspectRatio: .nan, in: size), expected)
        XCTAssertEqual(
            HeroZoomGeometry.fitRect(aspectRatio: 1.5, in: .zero),
            CGRect(origin: .zero, size: .zero)
        )
    }

    // MARK: - interpolate

    func testInterpolateRectEndpointsAndMidpoint() {
        let from = CGRect(x: 10, y: 20, width: 100, height: 100)
        let to = CGRect(x: 0, y: 200, width: 400, height: 300)

        XCTAssertEqual(HeroZoomGeometry.interpolate(from: from, to: to, progress: 0), from)
        XCTAssertEqual(HeroZoomGeometry.interpolate(from: from, to: to, progress: 1), to)

        let mid = HeroZoomGeometry.interpolate(from: from, to: to, progress: 0.5)
        XCTAssertEqual(mid.minX, 5, accuracy: 1e-9)
        XCTAssertEqual(mid.minY, 110, accuracy: 1e-9)
        XCTAssertEqual(mid.width, 250, accuracy: 1e-9)
        XCTAssertEqual(mid.height, 200, accuracy: 1e-9)
    }

    /// A spring that overshoots past 1 must keep carrying the hero, not
    /// clamp to the destination — that clamp would read as a hard stop.
    func testInterpolateIsUnclampedForSpringOvershoot() {
        let from = CGRect(x: 0, y: 0, width: 100, height: 100)
        let to = CGRect(x: 0, y: 0, width: 200, height: 200)
        let overshot = HeroZoomGeometry.interpolate(from: from, to: to, progress: 1.1)
        XCTAssertEqual(overshot.width, 210, accuracy: 1e-9)
    }

    func testInterpolateScalar() {
        XCTAssertEqual(HeroZoomGeometry.interpolate(from: 4, to: 0, progress: 0), 4, accuracy: 1e-9)
        XCTAssertEqual(HeroZoomGeometry.interpolate(from: 4, to: 0, progress: 0.25), 3, accuracy: 1e-9)
        XCTAssertEqual(HeroZoomGeometry.interpolate(from: 4, to: 0, progress: 1), 0, accuracy: 1e-9)
    }

    // MARK: - delayedRamp

    func testDelayedRampHoldsAtZeroUntilStart() {
        XCTAssertEqual(HeroZoomGeometry.delayedRamp(progress: 0, start: 0.4), 0, accuracy: 1e-9)
        XCTAssertEqual(HeroZoomGeometry.delayedRamp(progress: 0.4, start: 0.4), 0, accuracy: 1e-9)
        XCTAssertEqual(HeroZoomGeometry.delayedRamp(progress: 0.7, start: 0.4), 0.5, accuracy: 1e-9)
        XCTAssertEqual(HeroZoomGeometry.delayedRamp(progress: 1, start: 0.4), 1, accuracy: 1e-9)
    }

    func testDelayedRampClampsOutsideUnitRange() {
        XCTAssertEqual(HeroZoomGeometry.delayedRamp(progress: -0.3, start: 0.4), 0, accuracy: 1e-9)
        XCTAssertEqual(HeroZoomGeometry.delayedRamp(progress: 1.2, start: 0.4), 1, accuracy: 1e-9)
    }

    // MARK: - Interactive close

    func testCloseProgressMapsMagnificationOntoOpenProgress() {
        XCTAssertEqual(HeroZoomGeometry.closeProgress(magnification: 1), 1, accuracy: 1e-9)
        XCTAssertEqual(HeroZoomGeometry.closeProgress(magnification: 0.75), 0.5, accuracy: 1e-9)
        XCTAssertEqual(
            HeroZoomGeometry.closeProgress(
                magnification: HeroZoomGeometry.closeFullyCollapsedMagnification
            ),
            0,
            accuracy: 1e-9
        )
    }

    /// Pinching further than "fully collapsed", spreading back past the
    /// start, or a non-finite recognizer value must all stay in 0…1 — the
    /// hero rect is derived from this and must never invert.
    func testCloseProgressClamps() {
        XCTAssertEqual(HeroZoomGeometry.closeProgress(magnification: 0.1), 0, accuracy: 1e-9)
        XCTAssertEqual(HeroZoomGeometry.closeProgress(magnification: 2.5), 1, accuracy: 1e-9)
        XCTAssertEqual(HeroZoomGeometry.closeProgress(magnification: .nan), 1, accuracy: 1e-9)
    }

    func testShouldCommitCloseOnlyPastTheThreshold() {
        XCTAssertFalse(HeroZoomGeometry.shouldCommitClose(magnification: 1))
        XCTAssertFalse(HeroZoomGeometry.shouldCommitClose(magnification: 0.95))
        XCTAssertTrue(
            HeroZoomGeometry.shouldCommitClose(
                magnification: HeroZoomGeometry.closeCommitMagnification
            )
        )
        XCTAssertTrue(HeroZoomGeometry.shouldCommitClose(magnification: 0.6))
        XCTAssertFalse(HeroZoomGeometry.shouldCommitClose(magnification: .nan))
    }
}
