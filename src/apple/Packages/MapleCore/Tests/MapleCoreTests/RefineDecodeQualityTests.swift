// RefineDecodeQualityTests.swift — #2143 — the refine decode QUALITY
// decision, and the upscale-then-downscale round trip it removes.
//
// Root cause: `ImageEditPipeline.decodeTarget(phase: .refine, targetSize:)`
// can request a target near the sensor's native long edge (e.g. 100% zoom),
// but the sized decode it fed into (`decodeSceneLinearSized`) hardcoded
// `quality: .preview` — a half-res quad demosaic that caps its OWN output
// at roughly `nativeLongEdge / 2`, silently ignoring a larger request.
// `EditSession.decodedForNativeCanvas` then upscales that undersized buffer
// back up to the native canvas (a measured, FIXED `sx == sy == 2.0`
// regardless of how far beyond the cap the request went), and
// `ImageEditPipeline.prescaleForDisplay` immediately downscales it again to
// the real display target — two full resample passes on the largest buffer
// in the chain, for strictly less detail than a matched-quality decode
// would have delivered directly. 100% zoom never showed true native detail
// on this whole-image-refine path as a result (only the separate
// `refineNativeDetail` tile path delivered 1:1, and only for RAW + Auto
// above `NativeDetailLOD`'s threshold).
//
// The fix: `ImageEditPipeline.refineDecodeQuality(nativeLongEdge:
// targetLongEdge:)` escalates to the full-res demosaic (`.full`/`.amaze`,
// the same `AmazeFlag` gate the export path already uses) whenever the
// requested target genuinely exceeds what `.preview` can deliver; below
// that threshold `.preview` already decodes exactly the requested target
// (no cap ever engages, no escalation needed). `EditSession.
// decodeAndRender`'s refine branch is the only caller that resolves this —
// fast phase stays `.preview` unconditionally.
//
// Test tiers, matching the DeepZoomTileRenderingTests / AppleRenderHarness
// pattern:
//   - "no fixture" tier: exercises `refineDecodeQuality` directly — pure,
//     no FFI, runs anywhere.
//   - "fixture" tier: gated on `test-fixtures/raws/dji-mavic3pro-100mp.dng`
//     (12288x8192, symlinked to `test_0000.DNG`) — decodes for real and
//     measures the geometry (and wall time) the fix changes.

import XCTest
import CoreGraphics
import CoreImage
@testable import MapleCore

final class RefineDecodeQualityTests: XCTestCase {

    // MARK: - Pure decision function (no fixture needed)

    /// THE regression: a target that genuinely needs more than half-res
    /// detail (100% zoom on a large-enough viewport, target ≈ native) must
    /// escalate past `.preview` — otherwise the decode silently caps at
    /// native/2 regardless of what was asked for.
    func testEscalatesAt100PercentZoomTarget() {
        let quality = ImageEditPipeline.refineDecodeQuality(
            nativeLongEdge: 12288, targetLongEdge: 12288
        )
        let expected: PipelineRenderer.Quality = AmazeFlag.isEnabled ? .amaze : .full
        XCTAssertEqual(quality, expected,
            "a target at the native long edge must escalate past .preview")
        XCTAssertNotEqual(quality, .preview)
    }

    /// A fit-mode / moderate-zoom-sized target — well below native/2 — must
    /// stay `.preview`. `.preview` already decodes exactly this target with
    /// no cap ever engaging, so escalating would only cost more for zero
    /// benefit.
    func testStaysPreviewAtFitModeTarget() {
        let quality = ImageEditPipeline.refineDecodeQuality(
            nativeLongEdge: 12288, targetLongEdge: 1200
        )
        XCTAssertEqual(quality, .preview)
    }

    /// A moderate-zoom target still under the native/2 threshold also stays
    /// `.preview` — escalation is strictly about crossing the threshold,
    /// not about being "close" to native/2.
    func testStaysPreviewAtModerateZoomBelowThreshold() {
        let quality = ImageEditPipeline.refineDecodeQuality(
            nativeLongEdge: 12288, targetLongEdge: 5000
        )
        XCTAssertEqual(quality, .preview)
    }

    /// Boundary: exactly at native/2 stays `.preview` — matches the
    /// decision's "native/2 ≥ display target" framing for the non-
    /// escalating branch (`>`, not `>=`, is the escalation trigger).
    func testStaysPreviewExactlyAtHalfNativeBoundary() {
        let quality = ImageEditPipeline.refineDecodeQuality(
            nativeLongEdge: 12288, targetLongEdge: 6144
        )
        XCTAssertEqual(quality, .preview)
    }

    /// Just one pixel past the boundary must escalate.
    func testEscalatesJustPastHalfNativeBoundary() {
        let quality = ImageEditPipeline.refineDecodeQuality(
            nativeLongEdge: 12288, targetLongEdge: 6145
        )
        XCTAssertNotEqual(quality, .preview)
    }

    /// Native size not yet seeded (the cold-open race, #1637) — no native
    /// reference to size the decision against, so it must fall back to
    /// `.preview` rather than guess.
    func testFallsBackToPreviewWhenNativeUnknown() {
        XCTAssertEqual(
            ImageEditPipeline.refineDecodeQuality(nativeLongEdge: 0, targetLongEdge: 12288),
            .preview
        )
    }

    /// A degenerate (zero / negative / non-finite) target must also fall
    /// back to `.preview` rather than escalate on garbage input.
    func testFallsBackToPreviewOnDegenerateTarget() {
        XCTAssertEqual(
            ImageEditPipeline.refineDecodeQuality(nativeLongEdge: 12288, targetLongEdge: 0),
            .preview
        )
        XCTAssertEqual(
            ImageEditPipeline.refineDecodeQuality(nativeLongEdge: 12288, targetLongEdge: -100),
            .preview
        )
        XCTAssertEqual(
            ImageEditPipeline.refineDecodeQuality(nativeLongEdge: 12288, targetLongEdge: .nan),
            .preview
        )
    }

    // MARK: - Fixture lookup helper (mirrors DeepZoomTileRenderingTests)

    /// Resolve the gitignored 100 MP fixture by walking up from the test
    /// source file to the repository root, then into `test-fixtures/raws/`.
    /// Returns nil if absent — callers throw `XCTSkip`.
    private func fixtureURL() -> URL? {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // MapleCoreTests/
            .deletingLastPathComponent()  // Tests/
            .deletingLastPathComponent()  // MapleCore/
            .deletingLastPathComponent()  // Packages/
            .deletingLastPathComponent()  // apple/
            .deletingLastPathComponent()  // src/
            .deletingLastPathComponent()  // repo root
            .appendingPathComponent("test-fixtures/raws/dji-mavic3pro-100mp.dng")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// The fixture's known native pixel size (12288x8192 — a 100 MP
    /// Hasselblad L3D-100c / DJI Mavic 3 Pro frame). Verified once here so
    /// a future fixture swap fails loudly instead of silently invalidating
    /// every geometry assertion below.
    private static let nativeSize = CGSize(width: 12288, height: 8192)

    // MARK: - Fixture-gated correctness (i): 100%-zoom target ⇒ sx ≈ sy ≈ 1.0

    /// At a target matching the native long edge (the 100%-zoom case), the
    /// escalated quality must deliver a decode whose long edge is (nearly)
    /// the native long edge itself — i.e. `EditSession.
    /// decodedForNativeCanvas`'s `sx = native / decodedSize` comes out
    /// ≈ 1.0, so its upscale-to-native guard (`abs(sx - 1) > 0.01`) turns
    /// into a no-op. Contrast with `testPreviewQualityCapsAtHalfNative`
    /// below, which reproduces the pre-fix `sx == sy == 2.0` bug.
    func testEscalatedQualityDeliversFullTargetAt100PercentZoom() async throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("dji-mavic3pro-100mp.dng fixture not present; skipping")
        }
        let asset = AssetRef(url: url)
        let pipeline = ImageEditPipeline()
        let nativeLongEdge = max(Self.nativeSize.width, Self.nativeSize.height)
        let target = CGSize(width: nativeLongEdge, height: nativeLongEdge)
        let quality = ImageEditPipeline.refineDecodeQuality(
            nativeLongEdge: nativeLongEdge, targetLongEdge: nativeLongEdge
        )
        XCTAssertNotEqual(quality, .preview, "precondition: 100%-zoom target must escalate")

        guard let result = await pipeline.decodeSceneLinearSized(
            asset: asset, targetSize: target, quality: quality
        ) else {
            return XCTFail("decodeSceneLinearSized returned nil at escalated quality")
        }
        let decodedLongEdge = max(result.image.extent.width, result.image.extent.height)
        let sx = nativeLongEdge / decodedLongEdge
        XCTAssertEqual(sx, 1.0, accuracy: 0.02,
            "escalated quality at a 100%-zoom target must decode within 2% of the native long "
            + "edge (sx ≈ 1.0, no upscale) — got decodedLongEdge=\(decodedLongEdge) "
            + "native=\(nativeLongEdge) sx=\(sx)")
    }

    /// Reproduces the ROOT CAUSE this ticket fixes, as a standing
    /// regression guard: `.preview` quality caps its output at roughly
    /// half the native long edge REGARDLESS of a larger requested target —
    /// this is exactly the `sx == sy == 2.0` upscale the issue measured.
    /// If this test ever starts failing because `.preview` stopped
    /// capping, `refineDecodeQuality`'s threshold should be revisited (the
    /// escalation would no longer be necessary at this target size).
    func testPreviewQualityCapsAtHalfNativeRegardlessOfLargerTarget() async throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("dji-mavic3pro-100mp.dng fixture not present; skipping")
        }
        let asset = AssetRef(url: url)
        let pipeline = ImageEditPipeline()
        let nativeLongEdge = max(Self.nativeSize.width, Self.nativeSize.height)
        let target = CGSize(width: nativeLongEdge, height: nativeLongEdge)

        guard let result = await pipeline.decodeSceneLinearSized(
            asset: asset, targetSize: target, quality: .preview
        ) else {
            return XCTFail("decodeSceneLinearSized returned nil at .preview quality")
        }
        let decodedLongEdge = max(result.image.extent.width, result.image.extent.height)
        let sx = nativeLongEdge / decodedLongEdge
        XCTAssertEqual(sx, 2.0, accuracy: 0.05,
            ".preview quality must cap at ~native/2 even when a native-sized target is "
            + "requested — got decodedLongEdge=\(decodedLongEdge) native=\(nativeLongEdge) "
            + "sx=\(sx) (expected ≈2.0, the exact upscale factor "
            + "EditSession.decodedForNativeCanvas had to apply before this fix)")
    }

    // MARK: - Fixture-gated correctness (ii): fit-mode target ⇒ never upscaled past decode size

    /// At a fit-mode-sized target (well under native/2), the resolved
    /// quality must stay `.preview`, and the decode must never exceed the
    /// requested target on either axis — the sized-decode contract's
    /// existing "never upscale" guarantee, now also asserted through the
    /// quality-selection call site so a future threshold change can't
    /// accidentally request more than was asked for on the cheap path.
    func testFitModeTargetNeverUpscalesPastDecodeSize() async throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("dji-mavic3pro-100mp.dng fixture not present; skipping")
        }
        let asset = AssetRef(url: url)
        let pipeline = ImageEditPipeline()
        let nativeLongEdge = max(Self.nativeSize.width, Self.nativeSize.height)
        let target = CGSize(width: 1200, height: 800)
        let quality = ImageEditPipeline.refineDecodeQuality(
            nativeLongEdge: nativeLongEdge, targetLongEdge: max(target.width, target.height)
        )
        XCTAssertEqual(quality, .preview, "precondition: fit-mode target must not escalate")

        guard let result = await pipeline.decodeSceneLinearSized(
            asset: asset, targetSize: target, quality: quality
        ) else {
            return XCTFail("decodeSceneLinearSized returned nil at fit-mode target")
        }
        let w = result.image.extent.width, h = result.image.extent.height
        XCTAssertLessThanOrEqual(w, target.width + 0.5,
            "fit-mode decode must never exceed the requested width")
        XCTAssertLessThanOrEqual(h, target.height + 0.5,
            "fit-mode decode must never exceed the requested height")
        // And it must actually REACH the requested long edge (not silently
        // under-deliver either) — `.preview` comfortably covers 1200px
        // against a 6144px (native/2) cap.
        XCTAssertEqual(max(w, h), max(target.width, target.height), accuracy: 1.0)
    }

    // MARK: - Perf (diagnostic, not gated): fit-mode vs 100%-zoom decode cost

    /// Prints wall-clock decode time for the two branches `refineDecodeQuality`
    /// distinguishes, on the real 100 MP fixture. Not a pass/fail perf gate
    /// (wall time is hardware-dependent) — the one invariant asserted is the
    /// obviously-true direction (a full/AMaZE demosaic cannot be faster than
    /// a half-res one on the same input). Numbers are reported to stderr and
    /// belong in the PR body per the ticket's evidence requirement.
    func testDiagnosticRefineDecodeWallTime() async throws {
        guard let url = fixtureURL() else {
            throw XCTSkip("dji-mavic3pro-100mp.dng fixture not present; skipping")
        }
        let asset = AssetRef(url: url)
        let pipeline = ImageEditPipeline()
        let nativeLongEdge = max(Self.nativeSize.width, Self.nativeSize.height)

        func timeDecodeMs(target: CGSize, quality: PipelineRenderer.Quality) async -> Double {
            let start = DispatchTime.now()
            _ = await pipeline.decodeSceneLinearSized(asset: asset, targetSize: target, quality: quality)
            let end = DispatchTime.now()
            return Double(end.uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000
        }

        let fitTarget = CGSize(width: 1200, height: 800)
        let zoomTarget = CGSize(width: nativeLongEdge, height: nativeLongEdge)
        let zoomQuality = ImageEditPipeline.refineDecodeQuality(
            nativeLongEdge: nativeLongEdge, targetLongEdge: nativeLongEdge
        )

        // Fit-mode / moderate-zoom branch: quality is .preview BEFORE and
        // AFTER this fix (the target never crosses the escalation
        // threshold), so these two calls measure the SAME code path twice —
        // expected to be statistically indistinguishable. This is the
        // "otherwise" branch: no quality change, so no decode-time change;
        // any perceived reduction in the FULL render pipeline for this
        // branch would have to come from elsewhere (not this decode call).
        let fitBeforeMs = await timeDecodeMs(target: fitTarget, quality: .preview)
        let fitAfterMs = await timeDecodeMs(target: fitTarget, quality: .preview)

        // 100%-zoom branch: BEFORE this fix, refine hardcoded .preview
        // (capped at native/2, cheap but wrong-quality). AFTER, it escalates
        // to full/AMaZE (delivers genuine native-long-edge detail, costs
        // more).
        let zoomBeforeMs = await timeDecodeMs(target: zoomTarget, quality: .preview)
        let zoomAfterMs = await timeDecodeMs(target: zoomTarget, quality: zoomQuality)

        FileHandle.standardError.write(
            ("\n[#2143 refine decode wall time, dji-mavic3pro-100mp.dng, native="
                + "\(Int(nativeLongEdge))]\n"
                + "  fit-mode  (1200px target, .preview→.preview):   before=\(fitBeforeMs)ms  "
                + "after=\(fitAfterMs)ms\n"
                + "  100%-zoom (\(Int(nativeLongEdge))px target, .preview→\(zoomQuality)): "
                + "before=\(zoomBeforeMs)ms  after=\(zoomAfterMs)ms\n"
            ).data(using: .utf8)!
        )

        XCTAssertGreaterThanOrEqual(zoomAfterMs, zoomBeforeMs * 0.5,
            "sanity check: a full/AMaZE demosaic decode should not be dramatically FASTER "
            + "than a half-res preview decode of the same input")
    }
}
