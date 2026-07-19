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

    /// Machine-INDEPENDENT regression gate (#2113). The absolute
    /// `fusedCacheHitCeilingMs` above is machine-dependent; this ratio
    /// asserts the #2095 fusion win as meanFUSED / meanTWO-STEP measured in
    /// the SAME run — both arms share the machine, so the ratio is immune to
    /// absolute machine speed. Toggling ONLY the fused gate (input cache
    /// stays ON in both arms) isolates the fusion fix: a regression where
    /// the fused path silently stops engaging (re-introducing the second FFI
    /// round trip) pushes the fused arm up to the two-step arm and the ratio
    /// toward 1.0.
    ///
    /// Basis (100MP reference, Apple M5 Max, from
    /// docs/superpowers/perf/2026-07-19-100mp-instrument-pass.md §1b): fused
    /// ON mean 25.3 ms vs fused OFF (two-step, input cache still on) mean
    /// 36.2 ms → measured ratio ≈ 0.70. The two-step arm is the noisier of
    /// the two (its band spans ~33–42 ms), so the ceiling is set to 0.85 —
    /// above the 0.70 measurement with margin for that noise, yet below 1.0
    /// so a lost-fusion regression still trips it. One-way ratchet.
    private static let fusionRatioCeiling: Double = 0.85

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

        // Two arms, SAME build + SAME machine, measured back to back: the
        // #2095 fused chain+encode path ON (production default, one FFI
        // round trip per tick) and OFF (the exact pre-#2095 two-step path,
        // `applySceneLinearChainViaFFI` + `encodeDisplaySRGBViaFFI`). The
        // `_testSetFusedChainEncodeEnabled` hook overrides the init-time env
        // kill-switch at runtime so both arms run in ONE process. sharpen /
        // nr_color stay pinned at zero so the fusion gate holds throughout
        // the ON arm; exposure sweeps so `sceneLinearChainCache` (#661)
        // misses every tick and the FFI genuinely runs. The input cache
        // stays ON in both arms (only the fused gate differs), so the ratio
        // isolates the fusion win. The gate is process-global, so invalidate
        // the per-pipeline caches between arms and restore the env default
        // afterwards.
        let makeFusedModel: (Int) -> AdjustmentModel = { i in
            let t = Double(i) / Double(SliderTickPerfHarness.tickCount - 1)
            var model = AdjustmentModel.default
            model.sharpenAmount = 0.0
            model.nrColor = 0.0
            model.exposure = -1.0 + 2.0 * t
            return model
        }

        func runArm(fusionEnabled: Bool) -> SliderTickPerfHarness.DragStats {
            ImageEditPipeline._testSetFusedChainEncodeEnabled(fusionEnabled)
            pipeline.sceneLinearChainCache.invalidate()
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
                makeModel: makeFusedModel
            )
        }

        // Fusion ON first (production default = the absolute-ceiling/report
        // arm), then OFF. Restore the env default afterwards.
        let statsOn = runArm(fusionEnabled: true)
        let statsOff = runArm(fusionEnabled: false)
        ImageEditPipeline._testSetFusedChainEncodeEnabled(nil)

        let ratio = statsOn.mean / statsOff.mean
        let fixture = fixtureURL.lastPathComponent
        let summary = String(
            format: "[slider-tick-perf fused-chain-encode] " +
                    "fixture=%@ ticks=%d viewport=%dx%d " +
                    "mean=%.2fms p50=%.2fms p95=%.2fms max=%.2fms " +
                    "(process=%.2fms render=%.2fms) " +
                    "two-step-mean=%.2fms ratio(fused/two-step)=%.3f (ceiling=%.2f) " +
                    "spec(target=%.0fms hard=%.0fms) ceiling=%.0fms",
            fixture,
            SliderTickPerfHarness.tickCount,
            Int(SliderTickPerfHarness.viewportSize.width),
            Int(SliderTickPerfHarness.viewportSize.height),
            statsOn.mean, statsOn.p50, statsOn.p95, statsOn.max,
            statsOn.meanProcess, statsOn.meanRender,
            statsOff.mean, ratio, Self.fusionRatioCeiling,
            SliderTickPerfHarness.specTargetMs,
            SliderTickPerfHarness.specHardLimitMs,
            Self.fusedCacheHitCeilingMs
        )
        FileHandle.standardError.write(Data((summary + "\n").utf8))

        // Machine-INDEPENDENT gate (#2113): the fused arm must be at most
        // `fusionRatioCeiling` × the two-step arm. Both ran on this machine
        // in this run, so the ratio is immune to machine speed.
        let ratioText = String(format: "%.3f", ratio)
        let onMeanText = String(format: "%.2f", statsOn.mean)
        let offMeanText = String(format: "%.2f", statsOff.mean)
        let ratioCeilingText = String(format: "%.2f", Self.fusionRatioCeiling)
        let ratioMessage =
            "Fused/two-step ratio \(ratioText) " +
            "(fused \(onMeanText) ms / two-step \(offMeanText) ms) " +
            "exceeds the \(ratioCeilingText) ceiling — the #2095 fusion gate " +
            "(sharpenAmount/nrColor identity check) is no longer engaging, so " +
            "the second FFI round trip is back. Log `applyChainAndEncodeViaFusedFFI` " +
            "call count before relaxing this ratio."
        XCTAssertLessThan(ratio, Self.fusionRatioCeiling, ratioMessage)

        // Absolute fused-path ceiling (unchanged, machine-DEPENDENT) —
        // asserted against the production-default (fused ON) arm, kept as the
        // loose backstop it already was.
        XCTAssertLessThan(
            statsOn.mean, Self.fusedCacheHitCeilingMs,
            "Mean fused-chain-encode tick time \(String(format: "%.2f", statsOn.mean)) ms " +
            "exceeds the \(String(format: "%.0f", Self.fusedCacheHitCeilingMs)) ms ceiling " +
            "— verify the #2092 fusion gate (sharpenAmount/nrColor identity check) " +
            "is actually engaging (log `applyChainAndEncodeViaFusedFFI` call count)."
        )
    }
}
