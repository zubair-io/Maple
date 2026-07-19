// FusedChainEncodeSliderTickPerfTests.swift — #2092 fused-path perf bench.
//
// Sibling of `SliderTickPerfTests` (exposure-drag baseline). #2092 fuses
// `applySceneLinearChainViaFFI` + `encodeDisplaySRGBViaFFI` into a single
// FFI call (`maple_apply_chain_and_encode_display_f32`) whenever nothing
// runs between them — see `ImageEditPipeline.applyChainAndEncodeViaFusedFFI`.
// "Nothing runs between them" means `MetalKernels.applySceneSharpen` /
// `applySceneNRColor` are both identity, which only holds when
// `sharpenAmount` and `nrColor` are (numerically) zero.
//
// `AdjustmentModel.default` — the model `SliderTickPerfTests` drags — carries
// the reference-import defaults `sharpenAmount: 40, nrColor: 25`, so that
// bench's model NEVER satisfies the fusion gate and its numbers are
// unaffected by #2092 (verified: its measured mean does not move). This
// bench isolates the case the fusion actually changes: an exposure drag
// with sharpen/nr_color pinned at zero (a Neutral/no-sharpen/no-NR session,
// or any workflow where the user has turned both off).
//
// Two arms, same tick loop, gated by `MAPLE_DISABLE_FUSED_CHAIN_ENCODE`:
//
//   • Fused (default): the #2092 gate is live. One FFI round trip per tick
//     instead of two, and no intermediate CIImage wrap/readback between
//     them.
//   • Two-step (`MAPLE_DISABLE_FUSED_CHAIN_ENCODE=1`): the exact pre-#2092
//     code path, on the SAME build — not a stale git ref — so the two
//     numbers are directly comparable.
//
// Run:
//
//   MAPLE_PERF=1 swift test --filter FusedChainEncodeSliderTickPerfTests
//
//   # measure the pre-fusion (two-step) baseline on this same build
//   MAPLE_PERF=1 MAPLE_DISABLE_FUSED_CHAIN_ENCODE=1 \
//     swift test --filter FusedChainEncodeSliderTickPerfTests
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

final class FusedChainEncodeSliderTickPerfTests: XCTestCase {

    /// Fused-path ceiling — enforced against the measured mean with the
    /// fusion enabled (sharpen and nr_color both zero). Authorship numbers
    /// (#2092, M-series, 6 clean runs): fused means 27.90-31.39 ms, vs
    /// 40.07 / 40.24 / 43.23 ms with the fusion force-disabled on the SAME
    /// build (`MAPLE_DISABLE_FUSED_CHAIN_ENCODE=1`). 38 ms clears the worst
    /// clean fused mean (31.39) by ~21% — deliberately TIGHTER than the
    /// usual ~30% jitter margin (which would put it at ~41 ms), because
    /// ~41 ms sits above the two-step baseline's own 40 ms floor and a
    /// regression that silently re-introduced the second FFI round trip
    /// would then slip through; 38 ms keeps the gate strictly between the
    /// two bands. One-way ratchet — future wins lower it, never raise it
    /// (#1959 policy).
    private static let fusedCacheHitCeilingMs: Double = 38.0

    func testExposureSliderTickFusedChainEncode() async throws {
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

        // Warm-up render — same shape as the timed loop below (sharpen /
        // nr_color pinned at zero so the fusion gate is live from the
        // first tick, matching the live editor's "fusion already engaged"
        // steady state rather than clocking a one-time gate-miss).
        var warmModel = AdjustmentModel.default
        warmModel.sharpenAmount = 0.0
        warmModel.nrColor = 0.0
        warmModel.exposure = 0.1
        let warmProcessed = pipeline.processSceneLinear(
            decoded: decoded,
            model: warmModel,
            targetSize: SliderTickPerfHarness.viewportSize,
            asShot: asShot,
            decodedAtModel: warmModel,
            assetID: asset.id
        )
        SliderTickPerfHarness.forceRender(
            warmProcessed,
            ctx: ctx,
            device: device,
            commandQueue: commandQueue,
            destinationTexture: destTexture
        )

        // Timed loop — mutate exposure every tick (same shape as
        // `SliderTickPerfTests`) so `sceneLinearChainCache` (#661) misses
        // every tick and the FFI genuinely runs — sharpen/nr_color stay
        // pinned at zero so the #2092 gate holds throughout.
        var totals: [Double] = []
        var processSamples: [Double] = []
        var renderSamples: [Double] = []
        totals.reserveCapacity(SliderTickPerfHarness.tickCount)
        processSamples.reserveCapacity(SliderTickPerfHarness.tickCount)
        renderSamples.reserveCapacity(SliderTickPerfHarness.tickCount)

        for i in 0..<SliderTickPerfHarness.tickCount {
            let t = Double(i) / Double(SliderTickPerfHarness.tickCount - 1)
            var model = AdjustmentModel.default
            model.sharpenAmount = 0.0
            model.nrColor = 0.0
            model.exposure = -1.0 + 2.0 * t

            let tickStart = ContinuousClock.now
            let processed = pipeline.processSceneLinear(
                decoded: decoded,
                model: model,
                targetSize: SliderTickPerfHarness.viewportSize,
                asShot: asShot,
                decodedAtModel: model,
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
        let fusedState = ImageEditPipeline.fusedChainEncodeDisabled ? "disabled" : "enabled"
        let summary = String(
            format: "[slider-tick-perf fused-chain-encode=%@] " +
                    "fixture=%@ ticks=%d viewport=%dx%d " +
                    "mean=%.2fms p50=%.2fms p95=%.2fms max=%.2fms " +
                    "(process=%.2fms render=%.2fms) " +
                    "spec(target=%.0fms hard=%.0fms) ceiling=%.0fms",
            fusedState,
            fixture,
            SliderTickPerfHarness.tickCount,
            Int(SliderTickPerfHarness.viewportSize.width),
            Int(SliderTickPerfHarness.viewportSize.height),
            meanTotal, p50, p95, maxMs,
            meanProcess, meanRender,
            SliderTickPerfHarness.specTargetMs,
            SliderTickPerfHarness.specHardLimitMs,
            Self.fusedCacheHitCeilingMs
        )
        FileHandle.standardError.write(Data((summary + "\n").utf8))

        // Gate only when the fusion is enabled — the disabled arm exists
        // to characterise the pre-#2092 baseline on this same build, not
        // assert a ceiling against it.
        if fusedState == "enabled" {
            XCTAssertLessThan(
                meanTotal, Self.fusedCacheHitCeilingMs,
                "Mean fused-chain-encode tick time \(String(format: "%.2f", meanTotal)) ms " +
                "exceeds the \(String(format: "%.0f", Self.fusedCacheHitCeilingMs)) ms ceiling " +
                "— verify the #2092 fusion gate (sharpenAmount/nrColor identity check) " +
                "is actually engaging (log `applyChainAndEncodeViaFusedFFI` call count)."
            )
        }
    }
}
