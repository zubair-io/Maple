// ToneCurvePerfTests.swift — the 16ms slider-tick budget for a curve drag (#367).
//
// CLAUDE.md's performance invariant is a 16ms target / 50ms hard limit for a
// slider tick on the reference scene set, and the acceptance criterion for
// #367 is "smooth at 60Hz during drag on the 100 MP reference RAW". This
// measures that rather than asserting it.
//
// ## What a drag actually costs, and why this measures at canvas size
//
// The live wgpu session is NOT opened over the full sensor. `EditSession`'s
// `enterGpuLive` reads back the decode at `gpuTargetDims(for:targetSize:)` —
// the CANVAS target — and `GpuLiveDriver.open` uploads that. So a drag tick on
// the 100 MP reference RAW re-runs the chain over a canvas-sized buffer, not
// over 100.7 megapixels; the sensor resolution is paid once, at decode.
//
// Two things make that hold for a CURVE drag specifically, and both are new in
// #367: `RawCoreBridge.stripAppleGPUStages` strips the four `toneCurve*`
// fields, so a curve edit leaves the decode-cache key untouched and never
// re-decodes; and `GpuLiveSession.withGpuLiveParams` binds the curves into the
// live chain, so the edit is carried by the same per-tick uniform upload every
// other slider uses rather than by a re-develop.
//
// This measures at `2560 × 1707` — a full-screen Retina canvas for the
// reference frame's 3:2 aspect. For scale, the same loop at the full
// `12288 × 8192` sensor measures ~393 ms/tick: that is the cost of a
// full-resolution render, which is the refine/export path, not the drag path.
//
// The pixel CONTENT is synthetic, deliberately. The chain's per-tick cost is
// set by pixel count and by which stages are engaged, not by what the pixels
// depict — every stage is a branch-free per-pixel kernel — so a synthetic
// buffer at the true dimensions measures the true throughput while keeping the
// test free of a decode a drag never pays for.
//
// Opt-in via `MAPLE_PERF=1`: it needs a GPU and takes a few seconds, so it has
// no place in the default `swift test` run.

import XCTest
@testable import MapleCore

final class ToneCurvePerfTests: XCTestCase {

    /// A full-screen Retina canvas at the reference frame's 3:2 aspect — the
    /// size `gpuTargetDims` hands the live session for a 12288 × 8192 RAW.
    private static let canvasWidth = 2560
    private static let canvasHeight = 1707

    /// CLAUDE.md § Performance invariants.
    private static let targetMs = 16.0
    private static let hardLimitMs = 50.0

    func testCurveDragHoldsTheSliderTickBudget() async throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["MAPLE_PERF"] == "1",
            "perf test — set MAPLE_PERF=1 to run (needs a GPU)"
        )

        let (w, h) = (Self.canvasWidth, Self.canvasHeight)
        let session = try GpuLiveSession(pixels: Self.syntheticScene(w, h), width: w, height: h)

        var model = AdjustmentModel()
        model.profile = .neutral
        model.sharpenAmount = 0
        model.nrColor = 0

        // Warm-up: the first render pays for pipeline compilation and the
        // buffer upload, neither of which a drag pays for.
        _ = try await session.renderToBuffer(model: model)

        // A drag: 60 successive positions of one interior knot, which is what
        // the plot forwards at one write per display frame.
        var samples: [Double] = []
        for step in 0..<60 {
            let y = 0.35 + 0.3 * Double(step) / 59.0
            model.toneCurveLuma = ToneCurve(points: [(x: 0, y: 0), (x: 0.4, y: y), (x: 1, y: 1)])
            let t0 = CFAbsoluteTimeGetCurrent()
            _ = try await session.renderToBuffer(model: model)
            samples.append((CFAbsoluteTimeGetCurrent() - t0) * 1000)
        }

        let sorted = samples.sorted()
        let mean = samples.reduce(0, +) / Double(samples.count)
        let p95 = sorted[Int(Double(sorted.count) * 0.95)]
        let worst = sorted.last ?? 0

        print(
            """
            [tone-curve-perf] canvas \(w)×\(h), \(samples.count) drag ticks
            [tone-curve-perf]   mean \(String(format: "%.2f", mean)) ms
            [tone-curve-perf]   p95  \(String(format: "%.2f", p95)) ms
            [tone-curve-perf]   max  \(String(format: "%.2f", worst)) ms
            [tone-curve-perf]   budget: target \(Self.targetMs) ms, hard limit \(Self.hardLimitMs) ms
            """
        )

        // Gate on the HARD limit, not the target: the target is what the
        // scene set should hit, the hard limit is what may never regress.
        XCTAssertLessThan(
            p95, Self.hardLimitMs,
            "p95 curve-drag tick \(p95) ms exceeds the \(Self.hardLimitMs) ms hard limit"
        )
    }

    /// A scene-linear RGBA buffer with a wide, spatially-varying tonal range —
    /// so every stage in the chain has real work to do rather than hitting a
    /// flat-image short-circuit.
    private static func syntheticScene(_ w: Int, _ h: Int) -> [Float] {
        var pixels = [Float](repeating: 0, count: w * h * 4)
        pixels.withUnsafeMutableBufferPointer { buf in
            DispatchQueue.concurrentPerform(iterations: h) { y in
                let rowV = Float(y) / Float(h)
                for x in 0..<w {
                    let u = Float(x) / Float(w)
                    let i = (y * w + x) * 4
                    buf[i] = 0.02 + 3.5 * u * u
                    buf[i + 1] = 0.02 + 3.5 * rowV
                    buf[i + 2] = 0.02 + 3.5 * (1 - u) * rowV
                    buf[i + 3] = 1
                }
            }
        }
        return pixels
    }
}
