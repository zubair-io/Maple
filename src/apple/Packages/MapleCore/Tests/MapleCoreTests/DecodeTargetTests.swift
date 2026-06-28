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

    /// `renderFull()` (export prep) passes nil → refine still decodes
    /// full-resolution so export quality is unaffected.
    func testRefineNilTargetStaysFullRes() {
        XCTAssertNil(ImageEditPipeline.decodeTarget(phase: .refine, targetSize: nil))
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
}
