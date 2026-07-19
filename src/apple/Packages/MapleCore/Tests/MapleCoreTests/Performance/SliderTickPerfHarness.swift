// SliderTickPerfHarness.swift — shared utility surface for the slider-tick
// perf benches.
//
// Extracted from `SliderTickPerfTests.swift` in #661 so the new
// sharpen-drag bench (`SharpenSliderTickPerfTests`) can reuse fixture
// discovery, CIContext construction, and the GPU-blocking force-render
// helper without duplicating the harness in two files (and without
// pushing either file over the 600-line hard budget).
//
// Everything here is `internal` rather than `private` so sibling perf-
// test files in the same target can call into it. All helpers are
// static — the harness has no per-instance state. The shape mirrors the
// extraction patterns under `Helpers/` in MapleUITests.

import XCTest
import CoreImage
import CoreGraphics

#if canImport(Metal)
import Metal
#endif

@testable import MapleCore

/// Static utilities used by every slider-tick perf bench in this target.
enum SliderTickPerfHarness {

    // MARK: - Tunables (shared)

    /// Number of slider ticks per measurement run. Mirrors what a user
    /// dragging an Exposure slider produces in a typical ~0.8 s gesture
    /// at 60 Hz (~48 events). 50 is the round-number floor.
    static let tickCount = 50

    /// Viewport target size — the fast-pass renders at viewport
    /// resolution, not native. 1920 × 1080 is the floor for a typical
    /// editor canvas on macOS at 1× scale; anything bigger is the same
    /// render with more pixels but the same algorithmic work per pixel.
    static let viewportSize = CGSize(width: 1920, height: 1080)

    /// Spec hard-limit per docs/spec/05-performance.md § Target budgets
    /// and CLAUDE.md "Performance invariants". Reported alongside every
    /// run for the spec-vs-reality delta.
    static let specHardLimitMs: Double = 50.0

    /// Spec target — the CLAUDE.md product invariant. Reported but
    /// never asserted; a perf bench gate that exceeds today's reality
    /// is a gate that catches nothing real.
    static let specTargetMs: Double = 16.0

    // MARK: - Fixture discovery

    /// `<repoRoot>/src/apple/Packages/MapleCore/Tests/MapleCoreTests/Performance/<file>.swift`
    /// → 8 levels up.
    static func repoRoot() -> URL {
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
    static func resolveFixture() -> URL? {
        let candidates = ["dji-mavic3pro-100mp.dng", "test_0017.dng"]
        let fm = FileManager.default

        let primary = repoRoot().appendingPathComponent("test-fixtures/raws")
        if fm.fileExists(atPath: primary.path) {
            for name in candidates {
                let url = primary.appendingPathComponent(name)
                if fm.fileExists(atPath: url.path) { return url }
            }
        }
        // Worktree fallback — climb `.claude/worktrees/<id>` to the host
        // repo.
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

    /// Build a CIContext mirroring `ImageEditPipeline.init` — Metal-
    /// backed with `extendedLinearSRGB` working space when a Metal
    /// device is available, software-backed with `linearSRGB`
    /// otherwise. Both branches use `.RGBAf` (the f32 working format
    /// that #487 migrated the pipeline to) and `cacheIntermediates:
    /// false`. This is the CIContext shape the live editor renders
    /// through, so the bench measures the same kernel-compile + filter-
    /// graph work the slider drag triggers.
    static func makeCIContext() -> CIContext {
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
    /// texture, then waiting on the GPU command buffer to complete. See
    /// the original `SliderTickPerfTests` doc-comment for the rationale
    /// (live editor doesn't read back; we just want the GPU pass time).
    static func forceRender(
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

        // Software fallback — no Metal device on this runner.
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
    static func makeDestinationTexture(
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

    /// Convert a `ContinuousClock.Duration` to milliseconds as a Double.
    static func elapsedMs(
        from start: ContinuousClock.Instant,
        to end: ContinuousClock.Instant
    ) -> Double {
        let d = end - start
        return Double(d.components.seconds) * 1000.0 +
               Double(d.components.attoseconds) / 1e15
    }

    // MARK: - Drag measurement (shared A/B loop)

    /// Per-tick latency stats for one drag measurement (one warm-up render
    /// followed by `tickCount` timed ticks). Returned by `measureDrag`.
    struct DragStats {
        let mean: Double
        let p50: Double
        let p95: Double
        let max: Double
        let meanProcess: Double
        let meanRender: Double
    }

    /// Run one warm-up render followed by `tickCount` timed ticks, each
    /// developing `makeModel(i)` through `processSceneLinear` + a forced GPU
    /// render, and return per-tick latency stats.
    ///
    /// This is the shared measurement kernel every slider-tick bench uses,
    /// for BOTH the fix-ON and fix-OFF arm of the machine-independent
    /// regression ratio (#2113). The caller configures the fix state (via
    /// the `_testSet…` cache/gate hooks) and invalidates any per-pipeline
    /// caches BEFORE calling — this helper is pure measurement and never
    /// touches the toggles itself.
    ///
    /// `decodedAtModel` mirrors the two live call shapes:
    ///   • `nil` — the exposure-drag benches pass the same per-tick model as
    ///     `decodedAtModel` (the decode baseline moves with the drag).
    ///   • non-nil — the sharpen bench pins `decodedAtModel` to the frozen
    ///     scene-linear model so the #661 chain cache hits every tick.
    static func measureDrag(
        pipeline: ImageEditPipeline,
        decoded: CIImage,
        asShot: ImageEditPipeline.AsShotWB?,
        assetID: UUID,
        ctx: CIContext,
        device: MTLDevice?,
        commandQueue: MTLCommandQueue?,
        destinationTexture: MTLTexture?,
        decodedAtModel: AdjustmentModel? = nil,
        makeModel: (Int) -> AdjustmentModel
    ) -> DragStats {
        // Warm-up render. Compiles CIKernels / warms the Metal pipeline
        // cache and primes the per-pipeline caches so the timed loop
        // measures steady-state ticks, not the one-time session-open cost
        // the live editor already absorbs.
        let warmModel = makeModel(0)
        let warmProcessed = pipeline.processSceneLinear(
            decoded: decoded,
            model: warmModel,
            targetSize: viewportSize,
            asShot: asShot,
            decodedAtModel: decodedAtModel ?? warmModel,
            assetID: assetID
        )
        forceRender(
            warmProcessed,
            ctx: ctx,
            device: device,
            commandQueue: commandQueue,
            destinationTexture: destinationTexture
        )

        var totals: [Double] = []
        var processSamples: [Double] = []
        var renderSamples: [Double] = []
        totals.reserveCapacity(tickCount)
        processSamples.reserveCapacity(tickCount)
        renderSamples.reserveCapacity(tickCount)

        for i in 0..<tickCount {
            let model = makeModel(i)
            let tickStart = ContinuousClock.now
            let processed = pipeline.processSceneLinear(
                decoded: decoded,
                model: model,
                targetSize: viewportSize,
                asShot: asShot,
                decodedAtModel: decodedAtModel ?? model,
                assetID: assetID
            )
            let processEnd = ContinuousClock.now
            forceRender(
                processed,
                ctx: ctx,
                device: device,
                commandQueue: commandQueue,
                destinationTexture: destinationTexture
            )
            let renderEnd = ContinuousClock.now

            let processMs = elapsedMs(from: tickStart, to: processEnd)
            let renderMs = elapsedMs(from: processEnd, to: renderEnd)
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

        return DragStats(
            mean: meanTotal,
            p50: p50,
            p95: p95,
            max: maxMs,
            meanProcess: meanProcess,
            meanRender: meanRender
        )
    }
}
