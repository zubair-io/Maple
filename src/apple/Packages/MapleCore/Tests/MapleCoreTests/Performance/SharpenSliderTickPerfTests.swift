// SharpenSliderTickPerfTests.swift — #661 cache-hit perf bench.
//
// Sibling of `SliderTickPerfTests` (exposure-drag baseline) — this bench
// holds every scene-linear input constant and varies only
// `sharpenAmount`. With the single-entry `SceneLinearChainCache` wired
// through `processSceneLinear` (ticket #661) every tick after the first
// is a cache hit: the FFI round-trip (≈50 ms GPU readback + Rust chain)
// is skipped and only the post-FFI Metal kernels (sharpen + nr_color)
// run.
//
// What this measures:
//
//   • Cache enabled (default): the cost of one slider tick when the
//     model hash matches the previous tick. This is the win the cache
//     ticket buys — the user dragging Sharpness should not pay for the
//     scene-linear chain on every event.
//
//   • Cache disabled (set `MAPLE_DISABLE_FFI_CACHE=1` alongside
//     `MAPLE_PERF=1`): the same tick path forced through the FFI on
//     every iteration. Used to characterise the baseline when ratcheting
//     the ceiling.
//
// Run:
//
//   MAPLE_PERF=1 swift test --filter SharpenSliderTickPerfTests
//
//   # measure the no-cache baseline
//   MAPLE_PERF=1 MAPLE_DISABLE_FFI_CACHE=1 \
//     swift test --filter SharpenSliderTickPerfTests
//
// Skip-passes when the reference RAW fixture is absent (matches the
// exposure bench convention).

import XCTest
import CoreImage
import CoreGraphics
@testable import MapleCore

#if canImport(Metal)
import Metal
#endif

final class SharpenSliderTickPerfTests: XCTestCase {

    /// Sharpen-drag ceiling — the path the #661 FFI cache makes cheap.
    /// On a cache hit `applySceneLinearChainViaFFI` returns immediately
    /// (no FFI readback, no Rust chain run), and only the post-FFI
    /// Metal kernels (sharpen + nr_color) execute. Set ~3× the observed
    /// mean at authorship time with the cache enabled; if the cache
    /// regresses (e.g. a slider added to the model gets folded into the
    /// hash by accident, or `assetID` plumbing breaks) this ceiling
    /// trips before the user-facing regression does.
    ///
    /// Lowered (not raised) by future perf wins; the disabled-cache
    /// arm (which doesn't gate) characterises the no-cache baseline.
    private static let sharpenCacheHitCeilingMs: Double = 80.0

    func testSharpenSliderTickCacheHit() async throws {
        guard ProcessInfo.processInfo.environment["MAPLE_PERF"] == "1" else {
            throw XCTSkip(
                "Set MAPLE_PERF=1 to run perf benches " +
                "(default `swift test` runs skip the slow harness)."
            )
        }
        guard let fixtureURL = SliderTickPerfHarness.resolveFixture() else {
            throw XCTSkip(
                "No RAW fixture available — looked for " +
                "test-fixtures/raws/dji-mavic3pro-100mp.dng and test_0017.dng. " +
                "CI without fixtures skip-passes."
            )
        }

        let pipeline = ImageEditPipeline()
        let asset = AssetRef(url: fixtureURL)
        guard let decoded = await pipeline.decodeSceneLinear(
            asset: asset,
            quality: .preview,
            xmpPath: nil
        ).map(\.image) else {
            throw XCTSkip(
                "decodeSceneLinear returned nil for \(fixtureURL.lastPathComponent) " +
                "(likely an unsupported RAW format in this build of rawler)."
            )
        }

        let asShot: ImageEditPipeline.AsShotWB? = {
            guard let meta = ImageMetadataReader.readAsShotWB(from: fixtureURL) else {
                return nil
            }
            return ImageEditPipeline.AsShotWB(
                temperature: meta.temperature,
                tint: meta.tint
            )
        }()

        let ctx = SliderTickPerfHarness.makeCIContext()
        #if canImport(Metal)
        let device = MTLCreateSystemDefaultDevice()
        let commandQueue = device?.makeCommandQueue()
        let destTexture = SliderTickPerfHarness.makeDestinationTexture(
            device: device, size: SliderTickPerfHarness.viewportSize
        )
        #else
        let device: MTLDevice? = nil
        let commandQueue: MTLCommandQueue? = nil
        let destTexture: MTLTexture? = nil
        #endif

        // Hold the scene-linear inputs constant — only `sharpenAmount`
        // varies. The first render warms the FFI cache; every
        // subsequent tick should be a hit and skip the FFI entirely.
        let frozenSceneModel = AdjustmentModel.default

        // Warm-up: same scene-linear shape the drag loop uses.
        let warmProcessed = pipeline.processSceneLinear(
            decoded: decoded,
            model: frozenSceneModel,
            targetSize: SliderTickPerfHarness.viewportSize,
            asShot: asShot,
            decodedAtModel: frozenSceneModel,
            assetID: asset.id
        )
        SliderTickPerfHarness.forceRender(
            warmProcessed,
            ctx: ctx,
            device: device,
            commandQueue: commandQueue,
            destinationTexture: destTexture
        )

        var totals: [Double] = []
        var processSamples: [Double] = []
        var renderSamples: [Double] = []
        totals.reserveCapacity(SliderTickPerfHarness.tickCount)
        processSamples.reserveCapacity(SliderTickPerfHarness.tickCount)
        renderSamples.reserveCapacity(SliderTickPerfHarness.tickCount)

        for i in 0..<SliderTickPerfHarness.tickCount {
            let t = Double(i) / Double(SliderTickPerfHarness.tickCount - 1)
            var model = frozenSceneModel
            // Sweep sharpen across [0, 100]. None of these fields are
            // in the FFI cache key, so the cache hits on every tick.
            model.sharpenAmount = 100.0 * t

            let tickStart = ContinuousClock.now
            let processed = pipeline.processSceneLinear(
                decoded: decoded,
                model: model,
                targetSize: SliderTickPerfHarness.viewportSize,
                asShot: asShot,
                decodedAtModel: frozenSceneModel,
                assetID: asset.id
            )
            let processEnd = ContinuousClock.now
            SliderTickPerfHarness.forceRender(
                processed,
                ctx: ctx,
                device: device,
                commandQueue: commandQueue,
                destinationTexture: destTexture
            )
            let renderEnd = ContinuousClock.now

            let processMs = SliderTickPerfHarness.elapsedMs(from: tickStart, to: processEnd)
            let renderMs = SliderTickPerfHarness.elapsedMs(from: processEnd, to: renderEnd)
            processSamples.append(processMs)
            renderSamples.append(renderMs)
            totals.append(processMs + renderMs)
        }

        let sortedTotals = totals.sorted()
        let meanTotal = totals.reduce(0, +) / Double(totals.count)
        let meanProcess = processSamples.reduce(0, +) / Double(processSamples.count)
        let meanRender = renderSamples.reduce(0, +) / Double(renderSamples.count)
        let p50 = sortedTotals[sortedTotals.count / 2]
        let p95 = sortedTotals[min(sortedTotals.count - 1,
                                   Int(Double(sortedTotals.count) * 0.95))]
        let maxMs = sortedTotals.last ?? 0

        let fixture = fixtureURL.lastPathComponent
        let cacheState = ProcessInfo.processInfo
            .environment["MAPLE_DISABLE_FFI_CACHE"] == "1" ? "disabled" : "enabled"
        let summary = String(
            format: "[slider-tick-perf sharpen-drag cache=%@] " +
                    "fixture=%@ ticks=%d viewport=%dx%d " +
                    "mean=%.2fms p50=%.2fms p95=%.2fms max=%.2fms " +
                    "(process=%.2fms render=%.2fms) " +
                    "spec(target=%.0fms hard=%.0fms) ceiling=%.0fms",
            cacheState,
            fixture,
            SliderTickPerfHarness.tickCount,
            Int(SliderTickPerfHarness.viewportSize.width),
            Int(SliderTickPerfHarness.viewportSize.height),
            meanTotal, p50, p95, maxMs,
            meanProcess, meanRender,
            SliderTickPerfHarness.specTargetMs,
            SliderTickPerfHarness.specHardLimitMs,
            Self.sharpenCacheHitCeilingMs
        )
        FileHandle.standardError.write(Data((summary + "\n").utf8))

        // Gate only when the cache is enabled — the disabled-cache arm
        // exists to characterise the no-cache baseline, not assert a
        // ceiling against it.
        if cacheState == "enabled" {
            XCTAssertLessThan(
                meanTotal, Self.sharpenCacheHitCeilingMs,
                "Mean sharpen-drag tick time \(String(format: "%.2f", meanTotal)) ms " +
                "exceeds the \(String(format: "%.0f", Self.sharpenCacheHitCeilingMs)) ms " +
                "cache-hit ceiling — the FFI cache is missing on a drag that " +
                "should hit (verify SceneLinearChainCache key construction and " +
                "the assetID plumbing through processSceneLinear)."
            )
        }
    }
}
