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
//   destination render. The XCTAssert gates on mean < `regressionCeilingMs`
//   (250 ms today after #661 — set ~2× the observed mean to ride out CI
//   scheduling jitter without flaking; see the doc comment on the
//   constant). The bench additionally emits an `[slider-tick-perf]
//   OVER-BUDGET` line to stderr when mean exceeds `specHardLimitMs` (50
//   ms) — that's a report, not a failure, because the per-tick FFI
//   round-trip floor currently lives above the spec hard limit. Closing
//   that gap to the CLAUDE.md product invariant (16 ms target / 50 ms
//   hard) is product work tracked separately; when the floor drops,
//   ratchet the ceiling down in the same commit (one-way ratchet, per
//   the spec policy).
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

    /// Regression-detection ceiling. Ratcheted 350 → 250 ms in #661
    /// when the single-entry FFI cache landed: the exposure-drag bench
    /// still misses on every tick (exposure is in the cache key), so
    /// the underlying processSceneLinear floor is unchanged — but the
    /// previous 350 ms ceiling was set ~3× a ~115 ms observed mean as
    /// jitter padding. With the cache plumbing in place a 250 ms
    /// ceiling is still ~2× the observed mean, plenty of headroom for
    /// CI scheduling jitter without flaking, and tight enough that a
    /// 2× regression in `processSceneLinear` (the load-bearing call)
    /// trips it.
    ///
    /// The sharpen-drag variant lives in
    /// `SharpenSliderTickPerfTests` — that's where the cache actually
    /// buys the per-tick savings.
    ///
    /// Bumped only when a deliberate pipeline change raises the floor
    /// and we accept it; lowered when a perf win lands (the ratchet
    /// direction the spec demands).
    ///
    /// The spec target (16 ms) / hard limit (50 ms) are both *below*
    /// today's measured floor on the FFI round-trip path. Closing that
    /// gap is tracked separately (see the follow-up ticket linked from
    /// the PR body); this bench is the regression detector for whatever
    /// the current floor is.
    private static let regressionCeilingMs: Double = 250.0

    // MARK: - Test entry

    /// Slider-tick perf bench. Loads the reference fixture once, decodes
    /// once, primes the CIContext (first render is warm-up), then loops
    /// `tickCount` times: mutate exposure → process scene-linear → force
    /// pixel evaluation. Reports mean / p50 / p95 / max in ms and gates
    /// on `regressionCeilingMs` (the regression detector — well above
    /// today's floor). The spec hard limit is reported as an
    /// `OVER-BUDGET` stderr line when exceeded, but does not fail the
    /// assertion — see the `regressionCeilingMs` doc-comment for why.
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
                    "spec(target=%.0fms hard=%.0fms) ceiling=%.0fms",
            fixture,
            SliderTickPerfHarness.tickCount,
            Int(SliderTickPerfHarness.viewportSize.width),
            Int(SliderTickPerfHarness.viewportSize.height),
            meanTotal, p50, p95, maxMs,
            meanProcess, meanRender,
            SliderTickPerfHarness.specTargetMs,
            SliderTickPerfHarness.specHardLimitMs,
            Self.regressionCeilingMs
        )
        FileHandle.standardError.write(Data((summary + "\n").utf8))

        // 4. Gate on the regression ceiling. The spec target / hard
        //    limit are reported but not asserted — see the
        //    `regressionCeilingMs` doc-comment for why.
        // Build the failure message from precomputed locals to keep the Swift
        // expression type-checker under its complexity ceiling (#565/#787).
        let meanTotalText = String(format: "%.2f", meanTotal)
        let ceilingText = String(format: "%.0f", Self.regressionCeilingMs)
        let regressionMessage =
            "Mean slider-tick time \(meanTotalText) ms " +
            "exceeds the \(ceilingText) ms " +
            "regression ceiling — bench is reporting a step change in cost. " +
            "Investigate the per-tick path " +
            "(processSceneLinear → applySceneLinearChainViaFFI is the load-bearing call)."
        XCTAssertLessThan(
            meanTotal, Self.regressionCeilingMs,
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
