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

    // MARK: - #2143: the `.preview`-quality ceiling (nativeSize / 2)

    /// THE #2143 regression: at 100% zoom on a RAW with a known native size,
    /// the refine target can exceed what `quality: .preview` can ever
    /// deliver (native / 2 per axis). `decodeTarget` must clamp the request
    /// down to that ceiling rather than asking for more than the sized
    /// decode can produce — the over-request was previously absorbed by an
    /// upscale-to-native + downscale-to-target round trip that cost two full
    /// resample passes and delivered no more true detail than native/2.
    func testRawKnownNativeSizeCapsToPreviewCeiling() {
        let native = CGSize(width: 12000, height: 8000)
        // A 100%-zoom refine target close to native — bigger than native/2
        // on both axes.
        let target = CGSize(width: 10000, height: 6667)
        let result = ImageEditPipeline.decodeTarget(
            phase: .refine, targetSize: target, nativeSize: native, isRaw: true
        )
        XCTAssertEqual(result, CGSize(width: 6000, height: 4000))
    }

    /// A target already at or below the ceiling is passed through unchanged
    /// — the cap must never GROW a request, only shrink an over-large one.
    func testRawTargetBelowPreviewCeilingUnchanged() {
        let native = CGSize(width: 12000, height: 8000)
        let target = CGSize(width: 4000, height: 2667)
        let result = ImageEditPipeline.decodeTarget(
            phase: .refine, targetSize: target, nativeSize: native, isRaw: true
        )
        XCTAssertEqual(result, target)
    }

    /// A target sitting exactly on the ceiling is also unchanged (no
    /// off-by-one shrink at the boundary).
    func testRawTargetAtPreviewCeilingUnchanged() {
        let native = CGSize(width: 12000, height: 8000)
        let target = CGSize(width: 6000, height: 4000)
        let result = ImageEditPipeline.decodeTarget(
            phase: .refine, targetSize: target, nativeSize: native, isRaw: true
        )
        XCTAssertEqual(result, target)
    }

    /// `nativeSize == .zero` is the async pre-seed race
    /// (`seedNativeImageSizeFromMetadataAsync`) — the ceiling is unknown, so
    /// the request must pass through uncapped exactly as before #2143.
    func testRawUnknownNativeSizeUncapped() {
        let target = CGSize(width: 10000, height: 6667)
        let result = ImageEditPipeline.decodeTarget(
            phase: .refine, targetSize: target, nativeSize: .zero, isRaw: true
        )
        XCTAssertEqual(result, target)
    }

    /// A non-RAW asset never routes through the half-res-capped sized RAW
    /// decode — the cap must not apply regardless of `nativeSize`.
    func testNonRawUnchangedEvenWithKnownNativeSize() {
        let native = CGSize(width: 12000, height: 8000)
        let target = CGSize(width: 10000, height: 6667)
        let result = ImageEditPipeline.decodeTarget(
            phase: .refine, targetSize: target, nativeSize: native, isRaw: false
        )
        XCTAssertEqual(result, target)
    }

    /// The cap also applies to the fallback target (nil/degenerate input) —
    /// a tiny native asset (well under 2x the fallback cap) must not let the
    /// fallback exceed its own preview ceiling.
    func testRawFallbackTargetAlsoCappedOnTinyNativeSize() {
        let native = CGSize(width: 2000, height: 1200)
        let result = ImageEditPipeline.decodeTarget(
            phase: .refine, targetSize: nil, nativeSize: native, isRaw: true
        )
        XCTAssertEqual(result, CGSize(width: 1000, height: 600))
    }

    /// Cap applies identically on `.fast` — phase-independent by design
    /// (documented rationale: `.fast`'s own 1500 cap already sits well under
    /// `nativeSize / 2` for any real sensor, so this is normally a no-op,
    /// but the ceiling must still hold on an unusually small source).
    func testFastAlsoCapsToPreviewCeiling() {
        let native = CGSize(width: 2000, height: 1200)
        let target = CGSize(width: 1500, height: 900)
        let result = ImageEditPipeline.decodeTarget(
            phase: .fast, targetSize: target, nativeSize: native, isRaw: true
        )
        XCTAssertEqual(result, CGSize(width: 1000, height: 600))
    }
}
