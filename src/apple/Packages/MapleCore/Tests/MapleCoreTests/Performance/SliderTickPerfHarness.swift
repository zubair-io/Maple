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
}
