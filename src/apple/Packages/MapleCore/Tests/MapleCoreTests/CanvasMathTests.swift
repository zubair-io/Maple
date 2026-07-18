// CanvasMathTests.swift — Ticket 10 item I — DRY value type for
// canvas fit/zoom/framing math. Pure-function tests against known
// inputs; no SwiftUI / no MainActor.

import XCTest
import CoreGraphics
@testable import MapleCore

final class CanvasMathTests: XCTestCase {

    // MARK: - imageExtent gate

    /// `.zero` native size means metadata hasn't seeded yet — every
    /// derived geometric property must refuse to produce a value rather
    /// than anchor against a placeholder. Otherwise the canvas paints
    /// at preview-resolution dims (the iPad bug captured in
    /// FullImageView's notes on `imageExtent`).
    func testImageExtentNilWhenNativeIsZero() {
        let canvas = CanvasMath(
            viewportPx: CGSize(width: 1000, height: 800),
            nativeImageSize: .zero,
            pixelScale: 0,
            displayScale: 2
        )
        XCTAssertNil(canvas.imageExtent)
        XCTAssertNil(canvas.displayFrameInPoints)
    }

    func testImageExtentReturnsNativeWhenSeeded() {
        let canvas = CanvasMath(
            viewportPx: CGSize(width: 1000, height: 800),
            nativeImageSize: CGSize(width: 4000, height: 3000),
            pixelScale: 0
        )
        XCTAssertEqual(canvas.imageExtent, CGSize(width: 4000, height: 3000))
    }

    // MARK: - fit / effective scale

    /// 1000×800-px viewport on a 4000×3000-px native image fits at min
    /// ratio (1000/4000 = 0.25) — width is the binding edge.
    func testFitPixelScaleWidthBound() {
        let canvas = CanvasMath(
            viewportPx: CGSize(width: 1000, height: 800),
            nativeImageSize: CGSize(width: 4000, height: 3000),
            pixelScale: 0
        )
        XCTAssertEqual(canvas.fitPixelScale, 0.25, accuracy: 1e-6)
    }

    /// 2000×1200-px viewport on a 4000×3000-px native image fits at the
    /// height ratio (1200/3000 = 0.40) — height is now binding because
    /// the width ratio (2000/4000 = 0.50) is larger.
    func testFitPixelScaleHeightBound() {
        let canvas = CanvasMath(
            viewportPx: CGSize(width: 2000, height: 1200),
            nativeImageSize: CGSize(width: 4000, height: 3000),
            pixelScale: 0
        )
        XCTAssertEqual(canvas.fitPixelScale, 0.40, accuracy: 1e-6)
    }

    /// fitPixelScale guards return 1 when math is degenerate. Avoid
    /// returning 0 (which would zero out the display frame and the
    /// canvas would paint as a 0×0 collapsed frame).
    func testFitPixelScaleDegenerate() {
        let zero = CanvasMath(
            viewportPx: .zero,
            nativeImageSize: CGSize(width: 4000, height: 3000),
            pixelScale: 0
        )
        XCTAssertEqual(zero.fitPixelScale, 1)

        let noNative = CanvasMath(
            viewportPx: CGSize(width: 1000, height: 800),
            nativeImageSize: .zero,
            pixelScale: 0
        )
        XCTAssertEqual(noNative.fitPixelScale, 1)
    }

    /// `pixelScale == 0` resolves to `fitPixelScale`; non-zero values
    /// pass through verbatim (the user's explicit zoom).
    func testEffectivePixelScaleResolvesFitMode() {
        let fit = CanvasMath(
            viewportPx: CGSize(width: 1000, height: 800),
            nativeImageSize: CGSize(width: 4000, height: 3000),
            pixelScale: 0
        )
        XCTAssertEqual(fit.effectivePixelScale, 0.25, accuracy: 1e-6)

        let zoomed = CanvasMath(
            viewportPx: CGSize(width: 1000, height: 800),
            nativeImageSize: CGSize(width: 4000, height: 3000),
            pixelScale: 1.5
        )
        XCTAssertEqual(zoomed.effectivePixelScale, 1.5, accuracy: 1e-6)
    }

    // MARK: - displayFrameInPoints

    /// Frame is in POINTS = native_px × scale_real_per_image_px / displayScale.
    /// At fit on a retina (displayScale=2) display: native=4000×3000,
    /// viewport_px=1000×800 → fit=0.25 → frame_pt=4000*0.25/2=500 ×
    /// 3000*0.25/2=375.
    func testDisplayFrameInPointsAtFit() {
        let canvas = CanvasMath(
            viewportPx: CGSize(width: 1000, height: 800),
            nativeImageSize: CGSize(width: 4000, height: 3000),
            pixelScale: 0,
            displayScale: 2
        )
        let frame = canvas.displayFrameInPoints
        XCTAssertNotNil(frame)
        XCTAssertEqual(frame?.width ?? 0, 500, accuracy: 1e-6)
        XCTAssertEqual(frame?.height ?? 0, 375, accuracy: 1e-6)
    }

    /// At pixel-perfect (1.0) on retina: 4000 image px → 4000 real px →
    /// 2000 pts. Confirms the displayScale division applies regardless
    /// of fit vs explicit zoom.
    func testDisplayFrameInPointsAt1x() {
        let canvas = CanvasMath(
            viewportPx: CGSize(width: 1000, height: 800),
            nativeImageSize: CGSize(width: 4000, height: 3000),
            pixelScale: 1.0,
            displayScale: 2
        )
        let frame = canvas.displayFrameInPoints
        XCTAssertEqual(frame?.width ?? 0, 2000, accuracy: 1e-6)
        XCTAssertEqual(frame?.height ?? 0, 1500, accuracy: 1e-6)
    }

    // MARK: - target sizes

    /// `fastTargetSize` is just `viewportPx` when set, nil when zero.
    /// The pipeline falls back to its own 2 MP cap on nil.
    func testFastTargetSize() {
        let canvas = CanvasMath(
            viewportPx: CGSize(width: 1000, height: 800),
            nativeImageSize: CGSize(width: 4000, height: 3000),
            pixelScale: 0
        )
        XCTAssertEqual(canvas.fastTargetSize, CGSize(width: 1000, height: 800))

        let zero = CanvasMath(
            viewportPx: .zero,
            nativeImageSize: CGSize(width: 4000, height: 3000),
            pixelScale: 0
        )
        XCTAssertNil(zero.fastTargetSize)
    }

    /// In fit mode (`pixelScale == 0`), `refinedTargetSize` collapses
    /// to `fastTargetSize` (refine == fast). The session's refine
    /// scheduler short-circuits when the two match — without this, every
    /// fit-mode render fires a redundant refine pass.
    func testRefinedTargetSizeFitMode() {
        let canvas = CanvasMath(
            viewportPx: CGSize(width: 1000, height: 800),
            nativeImageSize: CGSize(width: 4000, height: 3000),
            pixelScale: 0
        )
        XCTAssertEqual(canvas.refinedTargetSize, CGSize(width: 1000, height: 800))
    }

    /// At pixel-perfect (1.0), refine targets full native size — when the
    /// 2×-viewport headroom cap (#1637) doesn't bind. Viewport 2500×2000 →
    /// cap 5000 ≥ native 4000, so the `max(...)` takes native.
    func testRefinedTargetSizeAt1x() {
        let canvas = CanvasMath(
            viewportPx: CGSize(width: 2500, height: 2000),
            nativeImageSize: CGSize(width: 4000, height: 3000),
            pixelScale: 1.0
        )
        XCTAssertEqual(canvas.refinedTargetSize, CGSize(width: 4000, height: 3000))
    }

    /// `pixelScale > 1` clamps to 1.0 in the refined target — the
    /// viewport's SwiftUI scale handles the upscale-past-native case
    /// while the pipeline output stays at native resolution. Viewport
    /// 2500×2000 keeps the 2×-viewport cap (#1637) at 5000 from binding so
    /// this still isolates the clamp.
    func testRefinedTargetSizeClampsBeyondNative() {
        let canvas = CanvasMath(
            viewportPx: CGSize(width: 2500, height: 2000),
            nativeImageSize: CGSize(width: 4000, height: 3000),
            pixelScale: 2.5
        )
        XCTAssertEqual(canvas.refinedTargetSize, CGSize(width: 4000, height: 3000))
    }

    /// #1637: the refined target is capped to 2× the viewport long edge so
    /// the full-frame refine decode — and the GPU-present buffer it feeds —
    /// can't approach the sensor on a large RAW and jetsam-kill iOS. Deep
    /// zoom past this routes through the per-tile path, not the full frame.
    /// Viewport 1000×800 → cap 2000; native 4000×3000 at 1× clamps to it.
    /// Only the long edge bounds memory (`develop_sized` takes a single
    /// `max_long_edge`); the pipeline preserves aspect.
    func testRefinedTargetSizeCapsToTwiceViewport() {
        let canvas = CanvasMath(
            viewportPx: CGSize(width: 1000, height: 800),
            nativeImageSize: CGSize(width: 4000, height: 3000),
            pixelScale: 1.0
        )
        XCTAssertEqual(canvas.refinedTargetSize, CGSize(width: 2000, height: 2000))
    }

    /// Pre-decode (nativeImageSize == .zero) fallback: refined target
    /// is `fast × min(max(1, pixelScale), 8)`. At pixelScale=1.5 →
    /// 1500×1200. Used while waiting for the metadata seed.
    func testRefinedTargetSizePreDecodeFallback() {
        let canvas = CanvasMath(
            viewportPx: CGSize(width: 1000, height: 800),
            nativeImageSize: .zero,
            pixelScale: 1.5
        )
        XCTAssertEqual(canvas.refinedTargetSize, CGSize(width: 1500, height: 1200))
    }

    /// #2061d: `refinedTargetSize` must never exceed Metal's 16384
    /// texture-edge ceiling, even when the 2×-viewport headroom cap
    /// (#1637) would otherwise permit it. A 9000×2000 viewport on a
    /// 20000×3000 native image: cap = min(9000*2, 16384) = 16384;
    /// width = min(max(20000, 9000), 16384) = 16384 (clamps); height =
    /// min(max(3000, 2000), 16384) = 3000 (native already under the cap).
    func testRefinedTargetSizeClampsToMetalMaxTextureEdge() {
        let canvas = CanvasMath(
            viewportPx: CGSize(width: 9000, height: 2000),
            nativeImageSize: CGSize(width: 20000, height: 3000),
            pixelScale: 1.0
        )
        let target = canvas.refinedTargetSize
        XCTAssertEqual(target?.width, CanvasMath.metalMaxTextureEdge)
        XCTAssertEqual(target?.height, 3000)
    }

    /// #2061d: the pre-decode fallback branch clamps the same way — an
    /// ultra-wide 2×-Retina viewport (9000×9000 real px) at pixelScale=3
    /// would otherwise compute `fast × min(max(1,3),2) = 18000` per edge,
    /// past the 16384 Metal ceiling.
    func testRefinedTargetSizePreDecodeFallbackClampsToMetalMaxTextureEdge() {
        let canvas = CanvasMath(
            viewportPx: CGSize(width: 9000, height: 9000),
            nativeImageSize: .zero,
            pixelScale: 3.0
        )
        XCTAssertEqual(
            canvas.refinedTargetSize,
            CGSize(width: CanvasMath.metalMaxTextureEdge, height: CanvasMath.metalMaxTextureEdge)
        )
    }

    // MARK: - visibleSourceRect

    /// At zoom 1.0 with a centred 1000×800-px viewport on a 4000×3000-px
    /// image, the visible rect is centred (1500, 1100, 1000, 800).
    func testVisibleSourceRectAtZoom1Centered() {
        let canvas = CanvasMath(
            viewportPx: CGSize(width: 1000, height: 800),
            nativeImageSize: CGSize(width: 4000, height: 3000),
            pixelScale: 1.0,
            panOffset: .zero,
            displayScale: 1
        )
        let rect = canvas.visibleSourceRect
        XCTAssertEqual(rect.minX, 1500, accuracy: 1e-6)
        XCTAssertEqual(rect.minY, 1100, accuracy: 1e-6)
        XCTAssertEqual(rect.width, 1000, accuracy: 1e-6)
        XCTAssertEqual(rect.height, 800, accuracy: 1e-6)
    }

    /// At zoom 2.0 the visible source extent halves (each real px shows
    /// half a source px) — viewport 1000×800 → 500×400 source px.
    func testVisibleSourceRectAtZoom2HalvesExtent() {
        let canvas = CanvasMath(
            viewportPx: CGSize(width: 1000, height: 800),
            nativeImageSize: CGSize(width: 4000, height: 3000),
            pixelScale: 2.0,
            panOffset: .zero,
            displayScale: 1
        )
        let rect = canvas.visibleSourceRect
        XCTAssertEqual(rect.width, 500, accuracy: 1e-6)
        XCTAssertEqual(rect.height, 400, accuracy: 1e-6)
    }

    /// In fit mode, `effectivePixelScale` resolves to `fitPixelScale`,
    /// so the visible rect covers the full image (clamped). For a
    /// width-bound viewport (1000×800 px on 4000×3000), fit gives 0.25;
    /// visible source = 4000×3200 clamped to 4000×3000 = full image.
    func testVisibleSourceRectInFitModeCoversImage() {
        let canvas = CanvasMath(
            viewportPx: CGSize(width: 1000, height: 800),
            nativeImageSize: CGSize(width: 4000, height: 3000),
            pixelScale: 0,
            panOffset: .zero,
            displayScale: 1
        )
        let rect = canvas.visibleSourceRect
        XCTAssertEqual(rect.width, 4000, accuracy: 1e-6)
        XCTAssertEqual(rect.height, 3000, accuracy: 1e-6)
    }

    /// Without a native image extent, the visible rect is `.zero` —
    /// the deep-zoom branch reads `.isEmpty` to gate.
    func testVisibleSourceRectZeroWithoutImage() {
        let canvas = CanvasMath(
            viewportPx: CGSize(width: 1000, height: 800),
            nativeImageSize: .zero,
            pixelScale: 1.0
        )
        XCTAssertEqual(canvas.visibleSourceRect, .zero)
    }

    /// Equality enables SwiftUI / observation diffing — two snapshots
    /// of the same inputs must be `==` so consumers can short-circuit
    /// re-derivation when nothing changed.
    func testEquatable() {
        let a = CanvasMath(
            viewportPx: CGSize(width: 1000, height: 800),
            nativeImageSize: CGSize(width: 4000, height: 3000),
            pixelScale: 1.0,
            panOffset: CGSize(width: 10, height: 20),
            displayScale: 2
        )
        let b = CanvasMath(
            viewportPx: CGSize(width: 1000, height: 800),
            nativeImageSize: CGSize(width: 4000, height: 3000),
            pixelScale: 1.0,
            panOffset: CGSize(width: 10, height: 20),
            displayScale: 2
        )
        XCTAssertEqual(a, b)
    }
}
