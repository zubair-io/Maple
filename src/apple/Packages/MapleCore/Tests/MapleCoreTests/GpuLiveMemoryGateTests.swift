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
    /// The 100 MP reference sensor (12288 px) now KEEPS the GPU path — an
    /// on-device trace showed a single open peaks at 4.8 GB and survives, so the
    /// gate was raised to 13000 px (#1647 M3).
    func test100MPSensorUsesGPU() {
        XCTAssertTrue(ImageEditPipeline.gpuLiveSupportsSensor(longEdge: 12288))
    }

    /// A sensor beyond the validated 100 MP class still falls back to CPU.
    func testBeyond100MPClassFallsBackToCPU() {
        XCTAssertFalse(ImageEditPipeline.gpuLiveSupportsSensor(longEdge: 14000))
    }

    /// A 45 MP sensor (≈8192 px) keeps the GPU path (it fits the budget).
    func test45MPSensorKeepsGPU() {
        XCTAssertTrue(ImageEditPipeline.gpuLiveSupportsSensor(longEdge: 8192))
    }

    /// A 24 MP sensor (≈6000 px) keeps the GPU path.
    func test24MPSensorKeepsGPU() {
        XCTAssertTrue(ImageEditPipeline.gpuLiveSupportsSensor(longEdge: 6000))
    }

    /// Unknown sensor size (0 — metadata not yet seeded, e.g. a bytes-provider
    /// / PhotoKit asset mid-fetch) falls back to CPU: taking the GPU path on a
    /// possibly-huge RAW before its size is known is exactly what OOM-killed a
    /// 100 MP library photo (#1637). GPU-live resumes once the size seeds.
    func testUnknownSensorFallsBackToCPU() {
        XCTAssertFalse(ImageEditPipeline.gpuLiveSupportsSensor(longEdge: 0))
    }

    /// The boundary is exclusive at the threshold and gates just above it.
    func testBoundary() {
        let t = CGFloat(ImageEditPipeline.gpuLiveMaxSensorLongEdge)
        XCTAssertTrue(ImageEditPipeline.gpuLiveSupportsSensor(longEdge: t))
        XCTAssertFalse(ImageEditPipeline.gpuLiveSupportsSensor(longEdge: t + 1))
    }
}
