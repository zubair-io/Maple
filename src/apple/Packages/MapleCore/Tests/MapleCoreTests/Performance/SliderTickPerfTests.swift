// SliderTickPerfTests.swift — automated slider-tick perf bench (#641).
//
// Why this exists:
//
//   The S5 Editor (PR #635) ships an Apple slider-drag path with a 16 ms
//   target / 50 ms hard-limit budget per CLAUDE.md and docs/spec/05-performance.md
//   (the spec table reads 33 ms target / 50 ms hard limit; the CLAUDE.md
//   product invariant is the tighter 16 ms one — both numbers are reported
//   so a regression triages cleanly). The S5 implementation was eyeballed
//   at 60 Hz on iPhone 17 Pro sim but had no automated regression coverage.
//
//   This bench drives the LIVE GPU work that a single slider tick performs.
//   The naive measurement — calling `EditorState.setArmedDisplayValue` in a
//   loop — would clock sub-millisecond struct math: the setter mutates
//   `session.model` and `model.didSet` calls `_scheduleRender(phase: .fast)`,
//   which returns immediately (RenderActor schedules the GPU work, doesn't
//   block). To catch render regressions we need to clock the GPU pass that
//   actually runs per tick.
//
//   Modeled on AppleRenderHarnessTests: load a real fixture once, decode
//   once, then per-tick re-run `processSceneLinear` against a mutated
//   `AdjustmentModel` and force pixel evaluation through a `CIContext`
//   render. That's the same work the live editor performs on every slider
//   movement, in viewport-sized fast-pass dimensions.
//
// #661 split: shared helpers (fixture discovery, CIContext build, GPU
// blocking render) live in `SliderTickPerfHarness.swift`. The sharpen-
// drag cache-hit bench lives in `SharpenSliderTickPerfTests.swift`. This
// file owns the exposure-drag baseline only.
//
// Why XCTSkip the default `swift test`:
//
//   The bench loads a multi-MP RAW, decodes it through the Rust core, and
//   re-renders 50 times. That's seconds of work — unsuitable for the
//   ~94-test inner loop. Gating on `MAPLE_PERF=1` keeps the bench available
//   for local triage and CI perf runs without slowing day-to-day work.
//
// How to run:
//
//   MAPLE_PERF=1 swift test --filter SliderTickPerfTests
//
//   The bench skip-passes when the reference RAW fixture is absent
//   (gitignored CI without `test-fixtures/raws/`).
//
// Fixture:
//
//   The bench falls back across two candidates, in order:
//     1. `test-fixtures/raws/dji-mavic3pro-100mp.dng` — the canonical
//        reference scene per CLAUDE.md. The 100 MP scale is the worst-case
//        the spec mentions; if the bench passes here it passes everywhere.
//     2. `test-fixtures/raws/test_0017.dng` — the UITest visual-harness
//        fixture (smaller, ~5 MP), used as a fallback so machines without
//        the 100 MP fixture can still run the bench.
//
// Reporting:
//
//   The bench prints a one-line summary to stderr with mean / p50 / p95 /
//   max in ms, plus the per-tick split between processSceneLinear and the
//   destination render. The XCTAssert gates on mean < `interimHardLimitMs`
//   (150 ms — the enforced ceiling, ratcheting toward the 50 ms spec hard
//   limit; see the doc comment on the constant and #1938/#1959). The bench
//   additionally emits an `[slider-tick-perf] OVER-BUDGET` line to stderr
//   when mean exceeds `specHardLimitMs` (50 ms) — that stays a report, not
//   a failure, because the per-tick FFI round-trip floor still lives above
//   the spec hard limit; the interim ceiling is what fails a genuine
//   regression today. Closing the floor-to-spec gap (16 ms target / 50 ms
//   hard) and ratcheting the interim down toward 50 ms is tracked in #1959
//   (one-way ratchet, per the spec policy).
//
// Cross-references:
//   docs/spec/05-performance.md § Target budgets, § Detailed timing decomposition
//   CLAUDE.md "Slider tick: 16ms target, 50ms hard limit"
//   src/apple/Packages/MapleCore/Tests/MapleCoreTests/AppleRenderHarnessTests.swift
//   src/apple/Packages/MapleCore/Sources/MapleCore/ImageEditPipeline.swift

import XCTest
import CoreImage
import CoreGraphics
@testable import MapleCore

#if canImport(Metal)
import Metal
#endif

final class SliderTickPerfTests: XCTestCase {

    // MARK: - Configuration

    /// The ENFORCED per-tick ceiling — an interim hard limit that
    /// ratchets toward the `specHardLimitMs` (50 ms) documented in
    /// CLAUDE.md, not the too-loose regression ceiling this bench used
    /// before (#1938).
    ///
    /// History: 350 → 250 ms (#661) as a pure regression detector set
    /// ~2–3× a ~115 ms observed mean for jitter padding. But 250 ms is
    /// 5× the 50 ms spec hard limit — a render 5× over budget still
    /// passed, so the assertion gave no signal against the actual
    /// product invariant (#1938). Tightened to 150 ms (#1938): still
    /// above the then-current FFI-round-trip floor with margin (measured
    /// mean ~72 ms on an M-series, ~115 ms on the #661 authorship
    /// machine), yet tight enough that a ~2× regression from the floor
    /// trips it.
    ///
    /// Tightened again to 65 ms (#1959): `applySceneLinearChainViaFFI`
    /// previously re-ran the GPU→CPU readback
    /// (`context.render(scaled, toBitmap:...)`) on EVERY slider tick even
    /// though the readback's INPUT (the decoded scene-linear CIImage,
    /// prescaled to the viewport) is invariant across an exposure-style
    /// drag — only the `AdjustmentModel` changes tick to tick.
    /// `FFIInputBufferCache` (a single-entry cache sibling to
    /// `SceneLinearChainCache`, keyed on the identity of the `decoded`
    /// CIImage + target size) now skips that readback on every tick after
    /// the first. Measured on an Apple M5 Max (macOS 26.4.1): mean
    /// dropped from ~59.75 ms (baseline, 3 runs: 58.82 / 63.27 / 57.15) to
    /// ~48.14 ms (3 clean post-change runs: 47.69 / 50.52 / 46.21 — a 4th
    /// run spiked to 185 ms / failed under heavy CONCURRENT system load
    /// from unrelated processes on this shared machine, confirmed via
    /// `uptime` load average >45; discarded as measurement noise, not a
    /// code regression). 65 ms clears the ~50.52 ms worst clean mean by
    /// ~29% margin — still above `specHardLimitMs` (the per-tick floor
    /// remains above spec: the Rust CPU chain compute itself, not just
    /// the readback, is the remaining cost) but a real ~2.3× tightening
    /// from 150 ms.
    ///
    /// This is deliberately an INTERIM limit ABOVE the 50 ms spec: the
    /// per-tick floor is currently above spec, so asserting 50 ms would
    /// fail on real hardware. Driving the floor down and ratcheting this
    /// toward 50 ms (one-way, per the spec policy — lowered in the same
    /// commit that delivers each win, never raised without an accepted
    /// pipeline change) is tracked in #1959. The `specHardLimitMs` /
    /// `specTargetMs` numbers are still reported every run (and an
    /// OVER-BUDGET line fires when the mean exceeds 50 ms) so the gap
    /// stays visible. The chain+encode FFI fusion (#2092,
    /// `maple_apply_chain_and_encode_display_f32`) landed but CANNOT move
    /// this bench's floor: the fusion is only valid when the Metal stages
    /// between the two FFI calls (sharpen / nr_color) are identity, and
    /// this bench drags `AdjustmentModel.default` — whose reference-import
    /// defaults are `sharpenAmount: 40, nrColor: 25` (#1933), so the
    /// fusion gate never engages here. The fused scenario has its own
    /// bench + ceiling: `FusedChainEncodeSliderTickPerfTests`.
    ///
    /// The sharpen-drag variant lives in `SharpenSliderTickPerfTests` —
    /// that's where the #661 FFI cache buys the per-tick savings and the
    /// floor is already near spec (an 80 ms cache-hit ceiling).
    private static let interimHardLimitMs: Double = 65.0

    /// Machine-INDEPENDENT regression gate (#2113). The absolute
    /// `interimHardLimitMs` above is machine-dependent — the ~2× win #2083
    /// (`FFIInputBufferCache`) buys can't be ratcheted into a fixed-ms
    /// ceiling without flaking on slower dev machines (#1959 documents a
    /// ~1.6× slower box). This ratio instead asserts the fix's benefit as
    /// meanON / meanOFF measured in the SAME run: both arms share the
    /// machine, so the RATIO is immune to absolute machine speed.
    ///
    /// Basis (100MP reference, Apple M5 Max, from
    /// docs/superpowers/perf/2026-07-19-100mp-instrument-pass.md §1a): input
    /// cache ON mean 41.7 ms vs OFF mean 75.7 ms → measured ratio ≈ 0.55.
    /// The ceiling is set to 0.72 — comfortably above the 0.55 measurement
    /// (≈0.17 headroom absorbs run-to-run jitter and cross-machine variance)
    /// yet far below 1.0, so a regression that neutralises the readback
    /// cache (ON ≈ OFF, ratio → 1.0) trips it decisively. One-way ratchet:
    /// tighten toward the measured 0.55 as confidence grows, never loosen.
    private static let inputCacheRatioCeiling: Double = 0.72

    // MARK: - Test entry

    /// Slider-tick perf bench. Loads the reference fixture once, decodes
    /// once, primes the CIContext (first render is warm-up), then loops
    /// `tickCount` times: mutate exposure → process scene-linear → force
    /// pixel evaluation. Reports mean / p50 / p95 / max in ms and gates
    /// on `interimHardLimitMs` (the enforced ceiling, ratcheting toward
    /// the 50 ms spec — see its doc-comment). The 50 ms spec hard limit
    /// is additionally reported as an `OVER-BUDGET` stderr line when the
    /// mean exceeds it, keeping the remaining gap visible (#1938/#1959).
    func testExposureSliderTick16ms() async throws {
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

        // 1. One-time decode + setup. These costs aren't part of the
        //    per-tick budget — the live editor pays them at session open,
        //    not on slider drag.
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

        // 2. Two arms, SAME build + SAME machine, measured back to back:
        //    the #2083 FFI input-readback cache ON (production default) and
        //    OFF. The `_testSetEnabled` hook overrides the init-time env
        //    kill-switch at runtime (env vars are read once at process
        //    start, so they can't be A/B'd within one run) and drops the
        //    slot, so each arm starts clean. The exposure sweep mutates the
        //    model every tick, so the #661 `sceneLinearChainCache` MISSES on
        //    every tick regardless of arm — only the input cache differs, so
        //    the ratio isolates #2083. The ON arm doubles as the absolute-
        //    ceiling + report arm below (it's the production default).
        //
        //    Timer inside `measureDrag` splits each tick into:
        //      • processSceneLinear — the FFI round-trip (GPU readback →
        //        Rust CPU chain → CIImage re-wrap), see
        //        `applySceneLinearChainViaFFI`.
        //      • forceRender — the GPU pass writing the Metal-kernel chain
        //        (sharpen + NRColor) into the destination texture.
        //
        //    The exposure sweep -1.0 → +1.0 EV gives each tick a distinct
        //    filter-graph evaluation; a static value could let CoreImage
        //    memoize across iterations.
        let makeExposureModel: (Int) -> AdjustmentModel = { i in
            let t = Double(i) / Double(SliderTickPerfHarness.tickCount - 1)
            var model = AdjustmentModel.default
            model.exposure = -1.0 + 2.0 * t
            return model
        }

        // HERMETICITY (#2113 / Copilot #2115): the ratio must isolate the
        // ONE fix each arm varies and be identical regardless of the
        // runner's MAPLE_DISABLE_* env vars. So every non-varied gate is
        // PINNED to a fixed state in BOTH arms via the same runtime hooks
        // (not merely invalidated — invalidate leaves the env-derived
        // enabled/disabled state in place), and all three hooks are reset to
        // nil in the `defer` below so nothing leaks to another test.
        defer {
            pipeline.ffiInputBufferCache._testSetEnabled(nil)
            pipeline.sceneLinearChainCache._testSetEnabled(nil)
            ImageEditPipeline._testSetFusedChainEncodeEnabled(nil)
        }

        func runArm(inputCacheEnabled: Bool) -> SliderTickPerfHarness.DragStats {
            // Varied fix — the #2083 input-readback cache.
            pipeline.ffiInputBufferCache._testSetEnabled(inputCacheEnabled)
            // Pinned: fusion DISABLED in both arms. `AdjustmentModel.default`
            // carries sharpen 40 / nrColor 25, so the #2095 fusion gate can
            // never engage on this bench regardless — the input-cache win is
            // measured on the (only reachable) two-step path. Pinning it here
            // means a runner's MAPLE_DISABLE_FUSED_CHAIN_ENCODE can't perturb
            // the ratio.
            ImageEditPipeline._testSetFusedChainEncodeEnabled(false)
            // Pinned: #661 chain cache ON (production default). The exposure
            // sweep mutates the model every tick, so this cache MISSES every
            // tick in both arms regardless of state; pinning it ON keeps a
            // runner's MAPLE_DISABLE_FFI_CACHE from mattering. Setting it also
            // drops the slot, so each arm starts clean.
            pipeline.sceneLinearChainCache._testSetEnabled(true)
            return SliderTickPerfHarness.measureDrag(
                pipeline: pipeline,
                decoded: decoded,
                asShot: asShot,
                assetID: asset.id,
                ctx: ctx,
                device: device,
                commandQueue: commandQueue,
                destinationTexture: destTexture,
                makeModel: makeExposureModel
            )
        }

        // ON first (production default = the absolute-ceiling/report arm),
        // then OFF. The `defer` above restores every gate to its env default.
        let statsOn = runArm(inputCacheEnabled: true)
        let statsOff = runArm(inputCacheEnabled: false)

        // 3. Report both arms + the measured ratio.
        let ratio = statsOn.mean / statsOff.mean
        let fixture = fixtureURL.lastPathComponent
        let summary = String(
            format: "[slider-tick-perf] fixture=%@ ticks=%d viewport=%dx%d " +
                    "mean=%.2fms p50=%.2fms p95=%.2fms max=%.2fms " +
                    "(process=%.2fms render=%.2fms) " +
                    "input-cache-OFF-mean=%.2fms ratio(on/off)=%.3f (ceiling=%.2f) " +
                    "spec(target=%.0fms hard=%.0fms) interim-hard=%.0fms",
            fixture,
            SliderTickPerfHarness.tickCount,
            Int(SliderTickPerfHarness.viewportSize.width),
            Int(SliderTickPerfHarness.viewportSize.height),
            statsOn.mean, statsOn.p50, statsOn.p95, statsOn.max,
            statsOn.meanProcess, statsOn.meanRender,
            statsOff.mean, ratio, Self.inputCacheRatioCeiling,
            SliderTickPerfHarness.specTargetMs,
            SliderTickPerfHarness.specHardLimitMs,
            Self.interimHardLimitMs
        )
        FileHandle.standardError.write(Data((summary + "\n").utf8))

        // 4a. Machine-INDEPENDENT gate (#2113): the input-cache ON arm must
        //     be at most `inputCacheRatioCeiling` × the OFF arm. Both arms
        //     ran on this machine in this run, so the ratio is immune to
        //     absolute machine speed — this is the enforceable form of the
        //     measured ~2× win.
        let ratioText = String(format: "%.3f", ratio)
        let onMeanText = String(format: "%.2f", statsOn.mean)
        let offMeanText = String(format: "%.2f", statsOff.mean)
        let ratioCeilingText = String(format: "%.2f", Self.inputCacheRatioCeiling)
        let ratioMessage =
            "Input-cache ON/OFF ratio \(ratioText) " +
            "(ON \(onMeanText) ms / OFF \(offMeanText) ms) " +
            "exceeds the \(ratioCeilingText) ceiling — the #2083 " +
            "FFIInputBufferCache is no longer buying its per-tick readback " +
            "saving (ON should be well under OFF). Investigate the input-cache " +
            "hit path (key construction / decoded-instance anchor) before " +
            "relaxing this ratio."
        XCTAssertLessThan(ratio, Self.inputCacheRatioCeiling, ratioMessage)

        // 4b. Absolute interim ceiling (unchanged, machine-DEPENDENT) — kept
        //     as the product-truth report + loose backstop it already was
        //     (#1959). Asserted against the production-default (ON) arm. The
        //     50 ms spec hard limit / 16 ms target are reported and the
        //     OVER-BUDGET line fires below.
        let meanTotalText = String(format: "%.2f", statsOn.mean)
        let ceilingText = String(format: "%.0f", Self.interimHardLimitMs)
        let hardLimitText = String(format: "%.0f", SliderTickPerfHarness.specHardLimitMs)
        let regressionMessage =
            "Mean slider-tick time \(meanTotalText) ms " +
            "exceeds the \(ceilingText) ms interim hard limit " +
            "(ratcheting toward the \(hardLimitText) ms spec — #1959). " +
            "Either a real per-tick regression, or the FFI floor moved: " +
            "investigate processSceneLinear → applySceneLinearChainViaFFI " +
            "(the load-bearing call) before relaxing the ceiling."
        XCTAssertLessThan(
            statsOn.mean, Self.interimHardLimitMs,
            regressionMessage
        )

        if statsOn.mean > SliderTickPerfHarness.specHardLimitMs {
            // Build the message from precomputed locals to keep the Swift
            // expression type-checker under its complexity ceiling (#565/#787).
            let meanText = String(format: "%.2f", statsOn.mean)
            let limitText = String(format: "%.0f", SliderTickPerfHarness.specHardLimitMs)
            let overBudgetMessage =
                "[slider-tick-perf] OVER-BUDGET: " +
                "mean \(meanText) ms exceeds " +
                "spec hard limit \(limitText) ms. " +
                "This is the known gap between the per-tick FFI round-trip cost " +
                "and the spec target — tracked separately, not a regression.\n"
            FileHandle.standardError.write(Data(overBudgetMessage.utf8))
        }
    }
}
