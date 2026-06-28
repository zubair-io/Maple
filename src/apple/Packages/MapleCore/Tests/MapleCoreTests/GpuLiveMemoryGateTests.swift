// GpuLiveMemoryGateTests.swift — #1637 — GPU-live large-sensor memory gate.
//
// The GPU-live present (wgpu storage buffers at display res + an in-driver
// auto-profile fit) plus the CPU develop exceeds the iOS ~6 GB per-process
// limit on very large sensors. A device A/B proved the same 100 MP open that
// jetsam-killed the app with GPU-live ON survives with it OFF. So large RAWs
// fall back to the CPU two-phase path; everything else keeps the GPU path.

import XCTest
import CoreGraphics
@testable import MapleCore

final class GpuLiveMemoryGateTests: XCTestCase {
    /// The 100 MP reference sensor (12288 px) must fall back to CPU.
    func test100MPSensorFallsBackToCPU() {
        XCTAssertFalse(ImageEditPipeline.gpuLiveSupportsSensor(longEdge: 12288))
    }

    /// A 45 MP sensor (≈8192 px) keeps the GPU path (it fits the budget).
    func test45MPSensorKeepsGPU() {
        XCTAssertTrue(ImageEditPipeline.gpuLiveSupportsSensor(longEdge: 8192))
    }

    /// A 24 MP sensor (≈6000 px) keeps the GPU path.
    func test24MPSensorKeepsGPU() {
        XCTAssertTrue(ImageEditPipeline.gpuLiveSupportsSensor(longEdge: 6000))
    }

    /// Unknown sensor size (0 — metadata not seeded) does NOT gate: the GPU
    /// path's own dims checks still apply, and we must not disable it on a
    /// missing-size false negative.
    func testUnknownSensorKeepsGPU() {
        XCTAssertTrue(ImageEditPipeline.gpuLiveSupportsSensor(longEdge: 0))
    }

    /// The boundary is exclusive at the threshold and gates just above it.
    func testBoundary() {
        let t = CGFloat(ImageEditPipeline.gpuLiveMaxSensorLongEdge)
        XCTAssertTrue(ImageEditPipeline.gpuLiveSupportsSensor(longEdge: t))
        XCTAssertFalse(ImageEditPipeline.gpuLiveSupportsSensor(longEdge: t + 1))
    }
}
