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
    /// product invariant (#1938). Tightened to 150 ms here: still above
    /// today's FFI-round-trip floor with margin (measured mean ~72 ms on
    /// an M-series, ~115 ms on the #661 authorship machine; the render
    /// phase itself is ~2 ms — the cost is the `processSceneLinear` FFI
    /// readback + Rust CPU chain, not the GPU present), yet tight enough
    /// that a ~2× regression from the floor trips it and anything near
    /// the old 250 ms territory fails hard.
    ///
    /// This is deliberately an INTERIM limit ABOVE the 50 ms spec: the
    /// per-tick floor is currently above spec, so asserting 50 ms would
    /// fail on real hardware. Driving the floor down and ratcheting this
    /// toward 50 ms (one-way, per the spec policy — lowered in the same
    /// commit that delivers each win, never raised without an accepted
    /// pipeline change) is tracked in #1959. The `specHardLimitMs` /
    /// `specTargetMs` numbers are still reported every run (and an
    /// OVER-BUDGET line fires when the mean exceeds 50 ms) so the gap
    /// stays visible.
    ///
    /// The sharpen-drag variant lives in `SharpenSliderTickPerfTests` —
    /// that's where the #661 FFI cache buys the per-tick savings and the
    /// floor is already near spec (an 80 ms cache-hit ceiling).
    private static let interimHardLimitMs: Double = 150.0

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

        // Warm-up render. The first render compiles CIKernels and warms
        // the Metal pipeline cache — clocking that into the per-tick mean
        // would punish the bench with a one-time hit the live editor
        // already absorbs at session open.
        var warmModel = AdjustmentModel.default
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

        // 2. Timed loop. Mutate exposure on each tick to mimic a slider
        //    drag — same shape as the editor's `setArmedDisplayValue` path
        //    (mutates `model.exposure`, which the live editor's
        //    `model.didSet` would then propagate through `_scheduleRender`).
        //    The exposure value sweeps -1.0 → +1.0 EV over the run so
        //    each tick produces a different filter-graph evaluation; a
        //    static value could let CoreImage memoize across iterations.
        //
        //    Timer is split into two phases so the report attributes the
        //    per-tick cost to either:
        //      • processSceneLinear — the FFI round-trip (GPU readback
        //        → Rust CPU chain → CIImage re-wrap) that runs
        //        synchronously inside the pipeline, see
        //        `applySceneLinearChainViaFFI`.
        //      • forceRender — the GPU pass that writes the final
        //        Metal-kernel chain (sharpen + NRColor) into the
        //        destination texture.
        var totals: [Double] = []
        var processSamples: [Double] = []
        var renderSamples: [Double] = []
        totals.reserveCapacity(SliderTickPerfHarness.tickCount)
        processSamples.reserveCapacity(SliderTickPerfHarness.tickCount)
        renderSamples.reserveCapacity(SliderTickPerfHarness.tickCount)

        for i in 0..<SliderTickPerfHarness.tickCount {
            // Sweep exposure across [-1, +1] EV. Avoids the
            // identity-shortcut some filters take at exactly zero.
            let t = Double(i) / Double(SliderTickPerfHarness.tickCount - 1)
            var model = AdjustmentModel.default
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

        // 3. Stats + report. Mean / p50 / p95 / max each computed across
        //    the total per-tick latency, plus mean attribution to the
        //    process vs render phases.
        let sortedTotals = totals.sorted()
        let meanTotal = totals.reduce(0, +) / Double(totals.count)
        let meanProcess = processSamples.reduce(0, +) / Double(processSamples.count)
        let meanRender = renderSamples.reduce(0, +) / Double(renderSamples.count)
        let p50 = sortedTotals[sortedTotals.count / 2]
        let p95 = sortedTotals[min(sortedTotals.count - 1,
                                   Int(Double(sortedTotals.count) * 0.95))]
        let maxMs = sortedTotals.last ?? 0

        let fixture = fixtureURL.lastPathComponent
        let summary = String(
            format: "[slider-tick-perf] fixture=%@ ticks=%d viewport=%dx%d " +
                    "mean=%.2fms p50=%.2fms p95=%.2fms max=%.2fms " +
                    "(process=%.2fms render=%.2fms) " +
                    "spec(target=%.0fms hard=%.0fms) interim-hard=%.0fms",
            fixture,
            SliderTickPerfHarness.tickCount,
            Int(SliderTickPerfHarness.viewportSize.width),
            Int(SliderTickPerfHarness.viewportSize.height),
            meanTotal, p50, p95, maxMs,
            meanProcess, meanRender,
            SliderTickPerfHarness.specTargetMs,
            SliderTickPerfHarness.specHardLimitMs,
            Self.interimHardLimitMs
        )
        FileHandle.standardError.write(Data((summary + "\n").utf8))

        // 4. Gate on the interim hard limit (the enforced ceiling that
        //    ratchets toward the 50 ms spec — see the `interimHardLimitMs`
        //    doc-comment). The 50 ms spec hard limit / 16 ms target are
        //    reported below and via the OVER-BUDGET line; the interim is
        //    the assertion because the FFI floor is currently above spec.
        // Build the failure message from precomputed locals to keep the Swift
        // expression type-checker under its complexity ceiling (#565/#787).
        let meanTotalText = String(format: "%.2f", meanTotal)
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
            meanTotal, Self.interimHardLimitMs,
            regressionMessage
        )

        if meanTotal > SliderTickPerfHarness.specHardLimitMs {
            // Build the message from precomputed locals to keep the Swift
            // expression type-checker under its complexity ceiling (#565/#787).
            let meanText = String(format: "%.2f", meanTotal)
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
