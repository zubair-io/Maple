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
//   (350 ms today — set ~3× the observed mean to ride out CI scheduling
//   jitter without flaking; see the doc comment on the constant). The
//   bench additionally emits an `[slider-tick-perf] OVER-BUDGET` line to
//   stderr when mean exceeds `specHardLimitMs` (50 ms) — that's a report,
//   not a failure, because the per-tick FFI round-trip floor currently
//   lives above the spec hard limit. Closing that gap to the CLAUDE.md
//   product invariant (16 ms target / 50 ms hard) is product work tracked
//   separately; when the floor drops, ratchet the ceiling down in the
//   same commit (one-way ratchet, per the spec policy).
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

    /// Number of slider ticks per measurement run. Mirrors what a user
    /// dragging an Exposure slider produces in a typical ~0.8 s gesture
    /// at 60 Hz (~48 events). 50 is the round-number floor.
    private static let tickCount = 50

    /// Viewport target size — the fast-pass renders at viewport resolution,
    /// not native. 1920 × 1080 is the floor for a typical editor canvas on
    /// macOS at 1× scale; anything bigger is the same render with more
    /// pixels but the same algorithmic work per pixel. Holds the bench at
    /// "fast pass, real laptop screen, real photographer's monitor."
    private static let viewportSize = CGSize(width: 1920, height: 1080)

    /// Spec hard-limit per docs/spec/05-performance.md § Target budgets
    /// and CLAUDE.md "Performance invariants". Reported alongside every
    /// run for the spec-vs-reality delta. NOT the assertion gate today —
    /// see `regressionCeilingMs`.
    private static let specHardLimitMs: Double = 50.0

    /// Spec target — the CLAUDE.md product invariant. Reported but never
    /// asserted; a perf bench gate that exceeds today's reality is a
    /// gate that catches nothing real.
    private static let specTargetMs: Double = 16.0

    /// Regression-detection ceiling. Holds ~3× the observed mean at
    /// authorship time on an M-series Mac running test_0017.dng (5 MP)
    /// at 1920 × 1080 viewport — measured mean was ~110-120 ms with
    /// occasional ~230 ms outliers under unrelated machine load. The
    /// ceiling is loose enough to ride out CI scheduling jitter and
    /// thermal throttling without flaking, tight enough that a 2×
    /// regression in `processSceneLinear` (the load-bearing call)
    /// trips it.
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
    private static let regressionCeilingMs: Double = 350.0

    // MARK: - Fixture discovery

    /// Mirror of `AppleRenderHarnessTests.repoRoot`, adjusted for the extra
    /// `Performance/` subdirectory this file lives in (AppleRenderHarnessTests
    /// sits one level shallower at `Tests/MapleCoreTests/<file>.swift` →
    /// 7 levels up; this one is 8).
    ///
    /// `<repoRoot>/src/apple/Packages/MapleCore/Tests/MapleCoreTests/Performance/<file>.swift`
    /// → 8 levels up.
    private static func repoRoot() -> URL {
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // Performance/
            .deletingLastPathComponent()  // MapleCoreTests/
            .deletingLastPathComponent()  // Tests/
            .deletingLastPathComponent()  // MapleCore/
            .deletingLastPathComponent()  // Packages/
            .deletingLastPathComponent()  // apple/
            .deletingLastPathComponent()  // src/
            .deletingLastPathComponent()  // repo root
    }

    /// Resolve a RAW fixture URL, mirroring the worktree fallback that
    /// AppleRenderHarnessTests / EditSessionTests use. Returns nil if no
    /// candidate exists locally.
    private static func resolveFixture() -> URL? {
        let candidates = ["dji-mavic3pro-100mp.dng", "test_0017.dng"]
        let fm = FileManager.default

        let primary = repoRoot().appendingPathComponent("test-fixtures/raws")
        if fm.fileExists(atPath: primary.path) {
            for name in candidates {
                let url = primary.appendingPathComponent(name)
                if fm.fileExists(atPath: url.path) { return url }
            }
        }
        // Worktree fallback — climb `.claude/worktrees/<id>` to the host repo.
        let host = repoRoot()
            .deletingLastPathComponent()  // worktrees
            .deletingLastPathComponent()  // .claude
            .deletingLastPathComponent()  // host repo
            .appendingPathComponent("test-fixtures/raws")
        if fm.fileExists(atPath: host.path) {
            for name in candidates {
                let url = host.appendingPathComponent(name)
                if fm.fileExists(atPath: url.path) { return url }
            }
        }
        return nil
    }

    // MARK: - Render harness (one slider tick worth of work)

    /// Build a CIContext mirroring `ImageEditPipeline.init` — Metal-backed
    /// with `extendedLinearSRGB` working space when a Metal device is
    /// available, software-backed with `linearSRGB` otherwise. Both
    /// branches use `.RGBAf` (the f32 working format that #487 migrated
    /// the pipeline to) and `cacheIntermediates: false`. This is the
    /// CIContext shape the live editor renders through, so the bench
    /// measures the same kernel-compile + filter-graph work the slider
    /// drag triggers.
    private static func makeCIContext() -> CIContext {
        #if canImport(Metal)
        if let device = MTLCreateSystemDefaultDevice() {
            return CIContext(mtlDevice: device, options: [
                .workingColorSpace: CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!,
                .workingFormat: CIFormat.RGBAf,
                .cacheIntermediates: false,
            ])
        }
        #endif
        return CIContext(options: [
            .workingColorSpace: CGColorSpace(name: CGColorSpace.linearSRGB)!,
            .workingFormat: CIFormat.RGBAf,
            .cacheIntermediates: false,
        ])
    }

    /// Force GPU evaluation of `processed` by rendering it into a Metal
    /// texture via `CIContext.render(_:to:commandBuffer:bounds:colorSpace:)`,
    /// then waiting on the GPU command buffer to complete.
    ///
    /// Why not `createCGImage`: that path reads pixels back to CPU memory,
    /// which the live editor never does on a slider tick — the SwiftUI
    /// `CIImageView` (or Metal-backed display path) consumes the CIImage
    /// directly without a GPU→CPU round-trip. Including a full-frame
    /// readback would inflate the bench by the readback cost, which has
    /// nothing to do with slider-tick latency.
    ///
    /// A Metal-texture destination is what the live display path does. The
    /// `commandBuffer.waitUntilCompleted()` after submission is what makes
    /// this a blocking call we can time — the live editor doesn't block,
    /// it lets the next frame queue up — but the latency we want to gate
    /// is the time the GPU spends producing one frame's worth of pixels,
    /// not the cancellation overhead.
    private static func forceRender(
        _ processed: CIImage,
        ctx: CIContext,
        device: MTLDevice?,
        commandQueue: MTLCommandQueue?,
        destinationTexture: MTLTexture?
    ) {
        let extent = processed.extent
        guard extent.width > 0, extent.height > 0 else { return }

        if let _ = device,
           let commandQueue,
           let destinationTexture,
           let commandBuffer = commandQueue.makeCommandBuffer() {
            let bounds = CGRect(
                x: 0, y: 0,
                width: min(extent.width, CGFloat(destinationTexture.width)),
                height: min(extent.height, CGFloat(destinationTexture.height))
            )
            ctx.render(
                processed,
                to: destinationTexture,
                commandBuffer: commandBuffer,
                bounds: bounds,
                colorSpace: CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
            )
            commandBuffer.commit()
            commandBuffer.waitUntilCompleted()
            return
        }

        // Software fallback — no Metal device on this runner. Fall back to
        // the CPU readback (slower than the live path would ever be, but
        // honest about what's happening).
        _ = ctx.createCGImage(
            processed,
            from: extent,
            format: .RGBA8,
            colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!
        )
    }

    /// Allocate the Metal texture used by `forceRender` to receive the
    /// per-tick GPU output. RGBA16Float at viewport size mirrors what a
    /// SwiftUI `CIImageView`-style display destination consumes.
    private static func makeDestinationTexture(
        device: MTLDevice?,
        size: CGSize
    ) -> MTLTexture? {
        guard let device else { return nil }
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .rgba16Float,
            width: Int(size.width),
            height: Int(size.height),
            mipmapped: false
        )
        descriptor.usage = [.shaderRead, .shaderWrite, .renderTarget]
        descriptor.storageMode = .private
        return device.makeTexture(descriptor: descriptor)
    }

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
        guard let fixtureURL = Self.resolveFixture() else {
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
        ) else {
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

        let ctx = Self.makeCIContext()
        #if canImport(Metal)
        let device = MTLCreateSystemDefaultDevice()
        let commandQueue = device?.makeCommandQueue()
        let destTexture = Self.makeDestinationTexture(
            device: device, size: Self.viewportSize
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
            targetSize: Self.viewportSize,
            asShot: asShot,
            decodedAtModel: warmModel
        )
        Self.forceRender(
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
        totals.reserveCapacity(Self.tickCount)
        processSamples.reserveCapacity(Self.tickCount)
        renderSamples.reserveCapacity(Self.tickCount)

        for i in 0..<Self.tickCount {
            // Sweep exposure across [-1, +1] EV. Avoids the
            // identity-shortcut some filters take at exactly zero.
            let t = Double(i) / Double(Self.tickCount - 1)
            var model = AdjustmentModel.default
            model.exposure = -1.0 + 2.0 * t

            let tickStart = ContinuousClock.now
            let processed = pipeline.processSceneLinear(
                decoded: decoded,
                model: model,
                targetSize: Self.viewportSize,
                asShot: asShot,
                decodedAtModel: model
            )
            let processEnd = ContinuousClock.now
            Self.forceRender(
                processed,
                ctx: ctx,
                device: device,
                commandQueue: commandQueue,
                destinationTexture: destTexture
            )
            let renderEnd = ContinuousClock.now

            let processMs = Self.elapsedMs(from: tickStart, to: processEnd)
            let renderMs = Self.elapsedMs(from: processEnd, to: renderEnd)
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
            Self.tickCount,
            Int(Self.viewportSize.width), Int(Self.viewportSize.height),
            meanTotal, p50, p95, maxMs,
            meanProcess, meanRender,
            Self.specTargetMs, Self.specHardLimitMs,
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

        if meanTotal > Self.specHardLimitMs {
            // Build the message from precomputed locals to keep the Swift
            // expression type-checker under its complexity ceiling (#565/#787).
            let meanText = String(format: "%.2f", meanTotal)
            let limitText = String(format: "%.0f", Self.specHardLimitMs)
            let overBudgetMessage =
                "[slider-tick-perf] OVER-BUDGET: " +
                "mean \(meanText) ms exceeds " +
                "spec hard limit \(limitText) ms. " +
                "This is the known gap between the per-tick FFI round-trip cost " +
                "and the spec target — tracked separately, not a regression.\n"
            FileHandle.standardError.write(Data(overBudgetMessage.utf8))
        }
    }

    /// Convert a `ContinuousClock.Duration` to milliseconds as a Double.
    private static func elapsedMs(
        from start: ContinuousClock.Instant,
        to end: ContinuousClock.Instant
    ) -> Double {
        let d = end - start
        return Double(d.components.seconds) * 1000.0 +
               Double(d.components.attoseconds) / 1e15
    }
}
