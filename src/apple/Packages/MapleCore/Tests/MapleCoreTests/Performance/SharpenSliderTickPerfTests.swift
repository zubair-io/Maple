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

    /// Machine-INDEPENDENT regression gate (#2113). The absolute
    /// `sharpenCacheHitCeilingMs` above is machine-dependent; this ratio
    /// asserts the #661 `SceneLinearChainCache` win as meanCACHE-ON /
    /// meanCACHE-OFF measured in the SAME run — both arms share the machine,
    /// so the ratio is immune to absolute machine speed. On a sharpen drag
    /// the scene-linear model is frozen (only `sharpenAmount`, excluded from
    /// the key, varies), so cache-ON hits every tick after the first and
    /// skips the FFI chain entirely — cache-OFF re-runs the Rust chain every
    /// tick. A regression that breaks the cache key (a scene-linear field
    /// wrongly folded into the digest, or the `assetID` plumbing breaking)
    /// turns cache-ON into cache-OFF and the ratio toward 1.0.
    ///
    /// Basis: measured on this machine as an in-run A/B (the 100MP
    /// instrument pass characterised this bench as insensitive to the input-
    /// cache / fusion flags — its win rides #661, which that pass did not
    /// A/B). The ceiling is set from the observed in-run ratio with a ~1.25×
    /// margin above the measurement, below 1.0 so a broken cache trips it.
    /// One-way ratchet — tighten as confidence grows, never loosen.
    private static let chainCacheRatioCeiling: Double = 0.75

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
        // varies (excluded from the #661 key, so the cache hits every tick).
        let frozenSceneModel = AdjustmentModel.default
        let makeSharpenModel: (Int) -> AdjustmentModel = { i in
            let t = Double(i) / Double(SliderTickPerfHarness.tickCount - 1)
            var model = frozenSceneModel
            model.sharpenAmount = 100.0 * t
            return model
        }

        // Two arms, SAME build + SAME machine, measured back to back: the
        // #661 `SceneLinearChainCache` ON (production default — every tick
        // after the first is a hit that skips the FFI chain) and OFF (forces
        // the FFI chain on every tick). `_testSetEnabled` overrides the
        // init-time `MAPLE_DISABLE_FFI_CACHE` env kill-switch at runtime so
        // both arms run in ONE process, and drops the slot so each arm starts
        // clean. `decodedAtModel` is pinned to the frozen scene model (as the
        // live sharpen drag does) so the scene-linear digest is stable and
        // the cache genuinely hits in the ON arm.
        func runArm(chainCacheEnabled: Bool) -> SliderTickPerfHarness.DragStats {
            pipeline.sceneLinearChainCache._testSetEnabled(chainCacheEnabled)
            pipeline.ffiInputBufferCache.invalidate()
            return SliderTickPerfHarness.measureDrag(
                pipeline: pipeline,
                decoded: decoded,
                asShot: asShot,
                assetID: asset.id,
                ctx: ctx,
                device: device,
                commandQueue: commandQueue,
                destinationTexture: destTexture,
                decodedAtModel: frozenSceneModel,
                makeModel: makeSharpenModel
            )
        }

        // Cache ON first (production default = the absolute-ceiling/report
        // arm), then OFF. Restore the env default afterwards.
        let statsOn = runArm(chainCacheEnabled: true)
        let statsOff = runArm(chainCacheEnabled: false)
        pipeline.sceneLinearChainCache._testSetEnabled(nil)

        let ratio = statsOn.mean / statsOff.mean
        let fixture = fixtureURL.lastPathComponent
        let summary = String(
            format: "[slider-tick-perf sharpen-drag] " +
                    "fixture=%@ ticks=%d viewport=%dx%d " +
                    "mean=%.2fms p50=%.2fms p95=%.2fms max=%.2fms " +
                    "(process=%.2fms render=%.2fms) " +
                    "cache-OFF-mean=%.2fms ratio(on/off)=%.3f (ceiling=%.2f) " +
                    "spec(target=%.0fms hard=%.0fms) ceiling=%.0fms",
            fixture,
            SliderTickPerfHarness.tickCount,
            Int(SliderTickPerfHarness.viewportSize.width),
            Int(SliderTickPerfHarness.viewportSize.height),
            statsOn.mean, statsOn.p50, statsOn.p95, statsOn.max,
            statsOn.meanProcess, statsOn.meanRender,
            statsOff.mean, ratio, Self.chainCacheRatioCeiling,
            SliderTickPerfHarness.specTargetMs,
            SliderTickPerfHarness.specHardLimitMs,
            Self.sharpenCacheHitCeilingMs
        )
        FileHandle.standardError.write(Data((summary + "\n").utf8))

        // Machine-INDEPENDENT gate (#2113): the cache-ON arm must be at most
        // `chainCacheRatioCeiling` × the cache-OFF arm. Both ran on this
        // machine in this run, so the ratio is immune to machine speed.
        let ratioText = String(format: "%.3f", ratio)
        let onMeanText = String(format: "%.2f", statsOn.mean)
        let offMeanText = String(format: "%.2f", statsOff.mean)
        let ratioCeilingText = String(format: "%.2f", Self.chainCacheRatioCeiling)
        let ratioMessage =
            "Chain-cache ON/OFF ratio \(ratioText) " +
            "(ON \(onMeanText) ms / OFF \(offMeanText) ms) " +
            "exceeds the \(ratioCeilingText) ceiling — the #661 SceneLinearChainCache " +
            "is missing on a sharpen drag that should hit. Verify the cache key " +
            "construction (a scene-linear field wrongly in the digest, or assetID " +
            "plumbing) before relaxing this ratio."
        XCTAssertLessThan(ratio, Self.chainCacheRatioCeiling, ratioMessage)

        // Absolute cache-hit ceiling (unchanged, machine-DEPENDENT) —
        // asserted against the production-default (cache ON) arm, kept as the
        // loose backstop it already was.
        XCTAssertLessThan(
            statsOn.mean, Self.sharpenCacheHitCeilingMs,
            "Mean sharpen-drag tick time \(String(format: "%.2f", statsOn.mean)) ms " +
            "exceeds the \(String(format: "%.0f", Self.sharpenCacheHitCeilingMs)) ms " +
            "cache-hit ceiling — the FFI cache is missing on a drag that " +
            "should hit (verify SceneLinearChainCache key construction and " +
            "the assetID plumbing through processSceneLinear)."
        )
    }
}
