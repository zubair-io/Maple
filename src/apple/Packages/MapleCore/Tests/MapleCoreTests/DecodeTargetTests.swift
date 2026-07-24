// DecodeTargetTests.swift — #1637 — the live decode-target decision.
//
// Pure-function tests: given a render `phase` and the caller's requested
// display target, what resolution does the decode run at? The refine
// phase must HONOUR a bounded target rather than force full-resolution —
// otherwise a 100 MP RAW allocates the full-sensor demosaic + a full-res
// GPU-present texture on cold open and jetsam-kills iOS (the #1637 OOM).
// Only `renderFull()` (export prep, nil target) still decodes full-res.

import XCTest
import CoreGraphics
@testable import MapleCore

final class DecodeTargetTests: XCTestCase {
    private let cap = CGFloat(ImageEditPipeline.fastPhaseFallbackLongEdge)

    /// THE regression: refine handed a bounded display target must decode
    /// at that target (→ the sized/half-res path), not full-res (`nil`).
    func testRefineHonoursBoundedTarget() {
        let target = CGSize(width: 2000, height: 1333)
        XCTAssertEqual(
            ImageEditPipeline.decodeTarget(phase: .refine, targetSize: target), target
        )
    }

    /// A nil target on `.refine` — including the cold-open race before the
    /// viewport seeds — caps to the fast fallback, NOT full-res (which would
    /// re-introduce the large-RAW OOM). Export uses the separate full-res
    /// `renderActor.renderForExport` path, so the live decode never needs nil.
    func testRefineNilTargetCapsToFallback() {
        XCTAssertEqual(
            ImageEditPipeline.decodeTarget(phase: .refine, targetSize: nil),
            CGSize(width: cap, height: cap)
        )
    }

    /// Fast phase honours its viewport target unchanged.
    func testFastHonoursTarget() {
        let target = CGSize(width: 1290, height: 2796)
        XCTAssertEqual(
            ImageEditPipeline.decodeTarget(phase: .fast, targetSize: target), target
        )
    }

    /// Fast phase NEVER decodes full-res — a nil target falls back to the
    /// conservative cap (the existing #785 invariant must not regress).
    func testFastNilTargetFallsBackToCap() {
        XCTAssertEqual(
            ImageEditPipeline.decodeTarget(phase: .fast, targetSize: nil),
            CGSize(width: cap, height: cap)
        )
    }

    /// A degenerate (zero / non-finite) target on the fast phase also caps.
    func testFastDegenerateTargetFallsBackToCap() {
        XCTAssertEqual(
            ImageEditPipeline.decodeTarget(phase: .fast, targetSize: .zero),
            CGSize(width: cap, height: cap)
        )
    }

    // MARK: - #2143: presentation targets capped at the DELIVERED extent

    /// THE #2143 regression: at 100% zoom the presentation targets (GPU
    /// present + CPU prescale) could exceed what the decode actually
    /// returned, so the pipeline published an upscale of the delivered
    /// buffer. The cap is keyed off the DELIVERED extent — never a
    /// predicted `native/2` divisor, which raw-core's
    /// `effective_quality_divisor` shows is Bayer-only (X-Trans and
    /// LinearRgb decode full-res at `.preview`; a predicted cap would
    /// wrongly downsample them).
    func testTargetAboveDeliveredIsCapped() {
        let delivered = CGSize(width: 6144, height: 4096)
        let target = CGSize(width: 9000, height: 6000)
        XCTAssertEqual(
            ImageEditPipeline.cappedToDelivered(target, delivered: delivered), delivered
        )
    }

    /// A target at or below the delivered extent passes through unchanged —
    /// the cap must never GROW a target.
    func testTargetAtOrBelowDeliveredUnchanged() {
        let delivered = CGSize(width: 6144, height: 4096)
        let below = CGSize(width: 4000, height: 2667)
        XCTAssertEqual(
            ImageEditPipeline.cappedToDelivered(below, delivered: delivered), below
        )
        XCTAssertEqual(
            ImageEditPipeline.cappedToDelivered(delivered, delivered: delivered), delivered
        )
    }

    /// `.zero` delivered = no decode recorded yet (cold open, invalidated
    /// cache) — the target must pass through uncapped.
    func testZeroDeliveredPassesThrough() {
        let target = CGSize(width: 9000, height: 6000)
        XCTAssertEqual(
            ImageEditPipeline.cappedToDelivered(target, delivered: .zero), target
        )
    }

    /// A full-res delivery (the X-Trans / LinearRgb `.preview` case) makes
    /// the cap a no-op for any target within native — the exact property a
    /// predicted `native/2` ceiling would have violated.
    func testFullResDeliveryNeverDownsamplesTarget() {
        let native = CGSize(width: 6240, height: 4160)
        let target = CGSize(width: 6000, height: 4000)
        XCTAssertEqual(
            ImageEditPipeline.cappedToDelivered(target, delivered: native), target
        )
    }

    /// Odd delivered dimensions cap exactly — no upward rounding past the
    /// delivered extent on either axis.
    func testOddDeliveredDimsCapExactly() {
        let delivered = CGSize(width: 6001, height: 4001)
        let target = CGSize(width: 9000, height: 6000)
        XCTAssertEqual(
            ImageEditPipeline.cappedToDelivered(target, delivered: delivered), delivered
        )
    }

    /// Axes cap independently: a target over-wide but under-tall only
    /// shrinks the axis that exceeds the delivered extent.
    func testAxesCapIndependently() {
        let delivered = CGSize(width: 6144, height: 4096)
        let target = CGSize(width: 8000, height: 3000)
        XCTAssertEqual(
            ImageEditPipeline.cappedToDelivered(target, delivered: delivered),
            CGSize(width: 6144, height: 3000)
        )
    }
}
