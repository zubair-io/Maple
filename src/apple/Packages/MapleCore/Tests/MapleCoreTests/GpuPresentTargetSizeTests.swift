// GpuPresentTargetSizeTests.swift — #1647 (M1) — GPU-live working-resolution cap.
//
// The wgpu live chain's FramePool allocates its ping-pong + spatial-scratch f32
// planes at the SESSION dims (16 B/px each). On a retina canvas (~6000+ px) that
// is the GPU footprint that OOMs a 100 MP open. The live preview is display-res
// anyway, so capping the session long edge (and upscaling to the drawable) bounds
// the GPU memory quadratically with negligible visible cost. Pure decision →
// unit-testable, mirrors `decodeTarget` / `gpuLiveSupportsSensor`.

import XCTest
import CoreGraphics
@testable import MapleCore

final class GpuPresentTargetSizeTests: XCTestCase {
    private let cap = CGFloat(ImageEditPipeline.gpuPresentMaxLongEdge)

    /// A retina-oversized target is scaled down to the cap, ASPECT PRESERVED
    /// (long edge → cap, short edge proportional). This is the memory win.
    func testOversizedTargetCapsAspectPreserved() {
        let big = CGSize(width: 7200, height: 4800) // 3:2, long edge 7200
        let out = ImageEditPipeline.gpuPresentTargetSize(big)
        XCTAssertEqual(max(out!.width, out!.height), cap, accuracy: 0.5)
        // aspect preserved: 3:2 in → 3:2 out
        XCTAssertEqual(out!.width / out!.height, 1.5, accuracy: 0.001)
    }

    /// A target already within the cap is returned unchanged — small sensors /
    /// non-retina displays keep full GPU-live resolution.
    func testWithinCapUnchanged() {
        let small = CGSize(width: 1290, height: 860)
        XCTAssertEqual(ImageEditPipeline.gpuPresentTargetSize(small), small)
    }

    /// Exactly at the cap is unchanged (boundary inclusive).
    func testAtCapUnchanged() {
        let edge = CGSize(width: cap, height: cap * 0.5)
        XCTAssertEqual(ImageEditPipeline.gpuPresentTargetSize(edge), edge)
    }

    /// nil target (no viewport yet) passes through — the present's own dims
    /// guard handles it.
    func testNilPassthrough() {
        XCTAssertNil(ImageEditPipeline.gpuPresentTargetSize(nil))
    }

    /// Portrait orientation caps the HEIGHT (the long edge), not the width.
    func testPortraitCapsLongEdge() {
        let tall = CGSize(width: 4800, height: 7200)
        let out = ImageEditPipeline.gpuPresentTargetSize(tall)
        XCTAssertEqual(max(out!.width, out!.height), cap, accuracy: 0.5)
        XCTAssertEqual(out!.height, cap, accuracy: 0.5)
    }
}
