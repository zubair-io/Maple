// MetalKernels.swift — Swift wrapper around the custom Metal CIKernels.
//
// Kernels are compiled from Metal source at app launch on first use.
//
// IMPORTANT: every cached kernel slot below is `CIKernel?`, never
// `CIColorKernel?`. All scene-linear kernels in this module use
// `coreimage::sampler_h` arguments (so they can sample at the source
// coord), which makes `CIKernel.kernels(withMetalString:)` return
// general `CIKernel` instances — NOT `CIColorKernel`. Casting those
// with `as? CIColorKernel` returns nil, and the wrapper functions
// silently `return input` — the user-visible symptom is that every
// slider except contrast (the AgX `sample_t` kernel, which IS a
// CIColorKernel) becomes a no-op. Bug 2 in Ticket 12 was exactly
// this. Do not reintroduce the CIColorKernel cast for `sampler_h`
// kernels.
//
// Parity with Rust: the same AgX LUT binary (agx_lut.bin) is embedded here
// via Bundle.module so both paths use the identical sigmoid table.
//
// Numeric tolerance per spec § 11 gate 4: ΔE ≤ 1.0 (≈ 1/255 in display).

import CoreImage
import Foundation
import Metal
import OSLog

private let kernelLog = OSLog(subsystem: "app.justmaple.maple", category: "MetalKernels")

/// True when the current process is hosting XCTest. Used to suppress the
/// DEBUG `assertionFailure` in `applyAgXViewTransform` when the unit-test
/// build doesn't compile the .metal sources to a metallib (Bundle.module
/// has no `default.metallib`, so the kernel loader returns nil — that's
/// expected under `swift test`, not a regression). The full Xcode build
/// does compile and embed the metallib, so the assertion still fires
/// there if a future change drops it.
private let isRunningUnderXCTest: Bool = {
    NSClassFromString("XCTestCase") != nil
}()

// MARK: - MetalKernels (namespace)

public enum MetalKernels {
    // Kernels are compiled lazily on first access.
    //
    // Slot type is `CIKernel?` — see file header. `sampler_h`-based kernels
    // are returned by `CIKernel.kernels(withMetalString:)` as `CIKernel`,
    // not `CIColorKernel`; the `as? CIColorKernel` cast that used to live
    // in the loaders silently nulled them out and made every slider except
    // contrast a no-op (Bug 2 in Ticket 12).
    private static var _sceneToneControls: CIKernel?
    private static var _sceneVibrance: CIKernel?
    private static var _whiteBalance: CIKernel?
    private static var _sceneSaturation: CIKernel?
    private static var _agxViewTransform: CIKernel?

    // Plan 2 v2 — SeparableGaussianBlur compute pipelines + shared helpers.
    // The blur is a `MTLComputePipeline` (not a `CIKernel`) because it
    // composes 6 stateful dispatches with ping-pong scratch textures.
    // Output is wrapped in a `CIImage` via `CIImage(mtlTexture:)` so the
    // downstream `CIKernel` chain (clarity / texture wrappers, added in
    // Task 4) consumes it like any other CIImage. This compute → CI
    // handoff was verified by Spike 1.1.
    private static var _separableGaussianBlurLib: MTLLibrary?
    private static var _separableBoxBlurHPipeline: MTLComputePipelineState?
    private static var _separableBoxBlurVPipeline: MTLComputePipelineState?
    /// Cached default Metal device — needed to build pipelines and
    /// allocate scratch textures. Lazy / process-lifetime cached, like
    /// the other kernel slots above.
    private static var _metalDevice: MTLDevice?

    // Plan 2 v2 — SceneUnsharp shared mix kernel (Task 4). Mirrors the
    // per-pixel `out = src + (src - blurred) * amount` mix from
    // raw-core/src/stages/clarity.rs:16-20 and texture.rs:16-20 (the two
    // Rust files are byte-identical at the mix level; only the upstream
    // blur radius differs). Loaded via the same `loadKernel(file:function:)`
    // path as the other kernel sources.
    //
    // Ticket 11 Bug B note: this per-channel-RGB unsharp kernel is no
    // longer used by `applySceneClarity` / `applySceneTexture` — both
    // stages now flow through SceneClarity.metal (luma-space, chroma-
    // preserving) to fix the magenta/cyan halo on coloured edges. The
    // SceneUnsharp source / loader stay in place for any future stage
    // that genuinely wants per-channel high-frequency boost without the
    // ratio rescale, but no production code path references it today.
    private static var _sceneUnsharp: CIKernel?

    // Ticket 11 Bug B (luma-space clarity / texture). Two kernels from
    // SceneClarity.metal: extractLuma (rec2020 -> (luma, luma, luma))
    // feeds the existing SeparableGaussianBlur scratch, then combine
    // (rec2020 + blurredLuma -> rec2020 with luma boost) re-applies the
    // boost as an RGB-uniform multiplier. Mirrors the Rust luma-space
    // clarity / texture in raw-core/src/stages/clarity.rs and
    // raw-core/src/stages/texture.rs (algorithm-identical; the only
    // difference between clarity & texture is the upstream blur radius).
    private static var _clarityExtractLuma: CIKernel?
    private static var _clarityCombine: CIKernel?

    // Plan 2 v2 v2 — SceneNRLuminance shared kernels (M3a, Task 2). Two
    // kernels: extractL (rec2020 -> oklab L splat for the blur input) and
    // combine (rec2020 + blurredL -> rec2020 with new L). Matches the
    // established lazy / process-lifetime cache pattern.
    private static var _sceneNRLuminanceExtract: CIKernel?
    private static var _sceneNRLuminanceCombine: CIKernel?

    // Plan 2 v2 v2 — SceneNRColor shared kernels (M3b, Task 4). Two
    // kernels: extractAB (rec2020 -> oklab a/b pack for the blur input)
    // and combine (rec2020 + blurredAB -> rec2020 with new a/b). Same
    // lazy / process-lifetime cache pattern.
    private static var _sceneNRColorExtract: CIKernel?
    private static var _sceneNRColorCombine: CIKernel?

    // Plan 2 v2 v3 — SceneSharpen kernels (M4, Tasks 2 + 3 + 4). Five
    // kernels orchestrated by applySceneSharpen:
    //   * rlRatio + rlMultiply: per-iteration RL arithmetic (Task 2).
    //   * sharpenLuminance + sharpenEdgeMix: edge-aware final mix (Task 3).
    //   * sharpenOverdrive: optional unsharp boost when amount > 100 (Task 4).
    // All five share the lazy / process-lifetime cache pattern.
    private static var _rlRatio: CIKernel?
    private static var _rlMultiply: CIKernel?
    private static var _sharpenLuminance: CIKernel?
    // sharpenEdgeMix uses neighbour sampling on `luma`, which requires
    // the general (spatial) CIKernel — same slot type as everything else.
    private static var _sharpenEdgeMix: CIKernel?
    private static var _sharpenOverdrive: CIKernel?

    // Plan 2 v2 v4 — Dehaze chain compute pipelines + libraries.
    // The 6 dehaze .metal sources are split across 4 MTLLibraries to
    // keep individual library compile times short — each is a single
    // `makeLibrary(source:)` call on first use, cached for the process
    // lifetime. Pipelines are built lazily on first use via
    // `dehazeDarkChannelPipeline()` etc.
    private static var _dehazeDarkAtmoTransLib: MTLLibrary?
    private static var _dehazeGuideLib: MTLLibrary?
    private static var _dehazeBoxBlurLib: MTLLibrary?
    private static var _dehazeGuidedFilterLib: MTLLibrary?

    private static var _dehazeDarkChannelPipeline: MTLComputePipelineState?
    private static var _dehazeAtmoPartialPipeline: MTLComputePipelineState?
    private static var _dehazeAtmoFinalPipeline: MTLComputePipelineState?
    private static var _dehazeTransmissionPipeline: MTLComputePipelineState?
    private static var _dehazeGuidePipeline: MTLComputePipelineState?
    private static var _dehazeBoxBlurHPipeline: MTLComputePipelineState?
    private static var _dehazeBoxBlurVPipeline: MTLComputePipelineState?
    private static var _dehazeBuildIpPipeline: MTLComputePipelineState?
    private static var _dehazeBuildIIPipeline: MTLComputePipelineState?
    private static var _dehazeCombineABPipeline: MTLComputePipelineState?
    private static var _dehazeUnpackRPipeline: MTLComputePipelineState?
    private static var _dehazeUnpackGPipeline: MTLComputePipelineState?

    private static var _dehazeReconstruct: CIKernel?

    // MARK: SceneToneControls

    public static func applySceneToneControls(
        to input: CIImage,
        exposure: Float,
        highlights: Float,
        shadows: Float,
        whites: Float,
        blacks: Float
    ) -> CIImage {
        guard let kernel = sceneToneControlsKernel() else { return input }
        // CIColorKernel.apply(extent:roiCallback:arguments:) — image is first argument
        let args: [Any] = [input, exposure, highlights, shadows, whites, blacks]
        return kernel.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: args
        ) ?? input
    }

    // MARK: SceneVibrance

    public static func applySceneVibrance(
        to input: CIImage,
        vibrance: Float
    ) -> CIImage {
        guard let kernel = sceneVibranceKernel() else { return input }
        return kernel.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [input, vibrance]
        ) ?? input
    }

    // MARK: WhiteBalance

    /// Apply scene-linear Rec.2020 white balance. The kernel takes the
    /// user's live WB and the WB the cached decode was rendered at; the
    /// gain is the ratio so slider ticks compose correctly with any
    /// Rust-side WB applied during decode. In Plan 2 v1 with `xmpPath`
    /// nil, decodedTemperature/decodedTint are 6500/0 (Rust default
    /// model = identity short-circuit at white_balance.rs:54), so the
    /// kernel applies the user's live WB directly. M3 (Tasks 7-8)
    /// generalises this once `xmpPath` is wired through `decodeSceneLinear`.
    public static func applyWhiteBalance(
        to input: CIImage,
        liveTemperature: Float,
        liveTint: Float,
        decodedTemperature: Float,
        decodedTint: Float
    ) -> CIImage {
        guard let kernel = whiteBalanceKernel() else { return input }
        let args: [Any] = [
            input,
            liveTemperature, liveTint,
            decodedTemperature, decodedTint,
        ]
        return kernel.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: args
        ) ?? input
    }

    // MARK: SceneSaturation

    /// Apply scene-linear Oklab uniform chroma scale. Mirrors
    /// `saturation::apply` from raw-core (saturation.rs:12). The math
    /// scales Oklab a/b uniformly by `1 + saturation/100`; no skin-tone
    /// protection (that lives in `applySceneVibrance`).
    public static func applySceneSaturation(
        to input: CIImage,
        saturation: Float
    ) -> CIImage {
        guard let kernel = sceneSaturationKernel() else { return input }
        return kernel.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [input, saturation]
        ) ?? input
    }

    // MARK: AgXViewTransform

    public static func applyAgXViewTransform(
        to input: CIImage,
        contrast: Float
    ) -> CIImage {
        guard let kernel = agxKernel() else {
            os_log(.error, log: kernelLog,
                "AgX kernel failed to load — view transform NOT applied; output will be raw scene-linear data. Check that AgXViewTransform.metal is bundled in the build.")
            #if DEBUG
            if !isRunningUnderXCTest {
                assertionFailure("AgX kernel must load — see os_log .error above")
            }
            #endif
            return input
        }
        // Ticket #08 fix: AgX sigmoid is now inlined as a 6-piece polynomial
        // in AgXViewTransform.metal (mirrors derive_agx_lut.py:97-103).
        // No LUT image argument needed — drops the broken-LUT-binding path.

        guard let out = kernel.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [input, contrast]
        ) else {
            os_log(.error, log: kernelLog,
                "AgX kernel.apply returned nil — view transform NOT applied; output will be raw scene-linear data.")
            #if DEBUG
            if !isRunningUnderXCTest {
                assertionFailure("AgX kernel.apply must succeed — see os_log .error above")
            }
            #endif
            return input
        }
        return out
    }

    // MARK: SeparableGaussianBlur (Plan 2 v2 M1)

    /// Apply the shared 3-pass box-blur Gaussian approximation (mirrors
    /// `gaussian_blur_rgb` in raw-core/src/stages/blur.rs) on a CIImage in
    /// scene-linear Rec.2020 fp16. Returns a new CIImage tagged
    /// extendedLinearITUR_2020. Used by both `applySceneClarity` (radius
    /// 40) and `applySceneTexture` (radius 3) wrappers added in Task 4 —
    /// only the radius differs.
    ///
    /// The blur runs as 6 compute dispatches (H, V, H, V, H, V) on a
    /// single command buffer with two ping-pong RGBA16Float textures.
    /// `r_box = max(1, radius / 3)` mirrors the Rust integer math at
    /// blur.rs:81 byte-for-byte.
    ///
    /// Returns `input` unchanged when:
    ///   - `radius == 0` (Rust short-circuit at blur.rs:78)
    ///   - any kernel-load / pipeline-build / texture-alloc step fails
    ///     (silent fallback per the existing wrapper convention)
    ///
    /// **Texture lifecycle:** allocates 3 fresh `MTLTexture` per call
    /// (`texSrc`, `texPing`, `texPong`) — `texSrc` receives the
    /// CIContext-rendered input, then 6 H/V dispatches ping-pong between
    /// `texPing` and `texPong`. After the H/V/H/V/H/V chain ends, the
    /// final write lands in `texPong`, which is wrapped in the returned
    /// `CIImage`. Lifetimes are governed by Swift ARC + the command
    /// buffer's hold-references-until-completion contract: as long as
    /// the returned `CIImage` is retained, `texPong` stays alive; the
    /// other two textures are released by ARC once this method returns
    /// and the command buffer drains. Per-call allocation is fine for
    /// editor workloads (clarity / texture only run when their slider
    /// is non-zero, debounced via the existing rendered-preview cache).
    public static func applySeparableGaussianBlur(
        to input: CIImage,
        radius: Int
    ) -> CIImage {
        if radius == 0 { return input }
        let rBox: UInt32 = UInt32(max(1, radius / 3))

        guard let device = metalDevice(),
              let pipelineH = separableBoxBlurHPipeline(),
              let pipelineV = separableBoxBlurVPipeline() else {
            return input
        }

        // Build an MTLTexture for the input by rendering the CIImage into
        // a fresh fp16 RGBA texture. fp16 RGBA matches the Rec.2020
        // working format the rest of the chain uses (per
        // ImageEditPipeline.swift, `.RGBAh` / extendedLinearITUR_2020).
        let extent = input.extent
        let w = max(1, Int(extent.width.rounded()))
        let h = max(1, Int(extent.height.rounded()))

        let desc = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .rgba16Float,
            width: w, height: h, mipmapped: false
        )
        desc.usage = [.shaderRead, .shaderWrite, .renderTarget]
        desc.storageMode = .private
        guard let texSrc = device.makeTexture(descriptor: desc),
              let texPing = device.makeTexture(descriptor: desc),
              let texPong = device.makeTexture(descriptor: desc) else {
            return input
        }

        // CIContext render of the input CIImage into texSrc.
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        let ciCtx = CIContext(mtlDevice: device, options: [
            .workingColorSpace: CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!,
            .workingFormat: CIFormat.RGBAh,
            .cacheIntermediates: false,
        ])
        guard let queue = device.makeCommandQueue(),
              let commandBuffer = queue.makeCommandBuffer() else {
            return input
        }
        ciCtx.render(
            input,
            to: texSrc,
            commandBuffer: commandBuffer,
            bounds: extent,
            colorSpace: space
        )

        // Compose the 6 passes on the same command buffer:
        //   texSrc  --H-->  texPing
        //   texPing --V-->  texPong
        //   texPong --H-->  texPing
        //   texPing --V-->  texPong
        //   texPong --H-->  texPing
        //   texPing --V-->  texPong
        // After 3 H+V pairs (= 3-pass Gaussian), texPong holds the result.
        let dispatches: [(MTLComputePipelineState, MTLTexture, MTLTexture)] = [
            (pipelineH, texSrc,  texPing),
            (pipelineV, texPing, texPong),
            (pipelineH, texPong, texPing),
            (pipelineV, texPing, texPong),
            (pipelineH, texPong, texPing),
            (pipelineV, texPing, texPong),
        ]
        for (pipeline, src, dst) in dispatches {
            guard let enc = commandBuffer.makeComputeCommandEncoder() else {
                return input
            }
            enc.setComputePipelineState(pipeline)
            enc.setTexture(src, index: 0)
            enc.setTexture(dst, index: 1)
            var rBoxLocal = rBox
            enc.setBytes(&rBoxLocal, length: MemoryLayout<UInt32>.size, index: 0)
            let tgSize = MTLSize(width: 16, height: 16, depth: 1)
            let tgCount = MTLSize(
                width:  (w + tgSize.width  - 1) / tgSize.width,
                height: (h + tgSize.height - 1) / tgSize.height,
                depth: 1
            )
            enc.dispatchThreadgroups(tgCount, threadsPerThreadgroup: tgSize)
            enc.endEncoding()
        }
        commandBuffer.commit()
        // Don't wait synchronously — return a CIImage wrapping texPong;
        // CoreImage will sync at the next render that depends on it.
        // (This is the "compute → CI" handoff verified by Spike 1.1.)

        let opts: [CIImageOption: Any] = [.colorSpace: space]
        return CIImage(mtlTexture: texPong, options: opts) ?? input
    }

    // MARK: SceneClarity / SceneTexture (Plan 2 v2 M2)

    /// Apply scene-linear Rec.2020 clarity (luma-space unsharp mask at
    /// radius 40). Mirrors `clarity::apply` from
    /// raw-core/src/stages/clarity.rs at the algorithm level.
    /// `clarity` is in [-100, +100]; 0 is identity. The 40-pixel radius
    /// is the binding constraint for Deep Zoom's 35-pixel overlap budget
    /// (per docs/superpowers/plans/2026-04-25-deep-zoom-tile-rendering.md
    /// § "Architecture" point 2). Do not change the radius without
    /// re-verifying that overlap.
    ///
    /// Composition (3 CIKernel.apply calls + 1 compute blur):
    ///   1. `clarityExtractLuma`   — splat dot(rgb, LUMA_REC2020) into RGB
    ///   2. `applySeparableGaussianBlur(to:radius:40)` on that splat
    ///   3. `clarityCombine`       — multiply rgb by (boost / max(luma, 1e-6))
    ///
    /// Ticket 11 Bug B fix: the previous implementation was a per-channel
    /// RGB unsharp via `sceneUnsharp` (`out = src + (src - blurred) *
    /// amount` per channel). At amount=1.0 on coloured edges that
    /// asymmetrically boosted R/G/B, surfacing as magenta/cyan halos
    /// around fine detail (Bug B in 11-Bugs.md). The luma-space variant
    /// preserves chromaticity exactly: R:G:B ratios are unchanged because
    /// the same scalar `boost / luma` multiplies all three channels.
    ///
    /// Silent-fallback to identity if any kernel-load step fails (matches
    /// the established convention in the other wrappers).
    public static func applySceneClarity(
        to input: CIImage,
        clarity: Float
    ) -> CIImage {
        if abs(clarity) < 1e-3 { return input }
        let amount = clarity / 100.0
        return applyLumaSpaceUnsharp(to: input, radius: 40, amount: amount)
    }

    /// Apply scene-linear Rec.2020 texture (luma-space unsharp mask at
    /// radius 3). Mirrors `texture::apply` from
    /// raw-core/src/stages/texture.rs at the algorithm level.
    /// `texture` is in [-100, +100]; 0 is identity.
    ///
    /// Identical algorithm to `applySceneClarity` — only the radius
    /// differs (3 vs 40). Same chroma-preservation argument applies, and
    /// the same kernel pair (`clarityExtractLuma` + `clarityCombine`) is
    /// reused — only the blur radius changes.
    public static func applySceneTexture(
        to input: CIImage,
        texture: Float
    ) -> CIImage {
        if abs(texture) < 1e-3 { return input }
        let amount = texture / 100.0
        return applyLumaSpaceUnsharp(to: input, radius: 3, amount: amount)
    }

    /// Shared implementation for clarity (radius 40) and texture
    /// (radius 3) — luma-extract → blur-luma → combine-as-RGB-multiplier.
    /// Mirrors `clarity::apply` / `texture::apply` in
    /// raw-core/src/stages/{clarity,texture}.rs.
    private static func applyLumaSpaceUnsharp(
        to input: CIImage,
        radius: Int,
        amount: Float
    ) -> CIImage {
        guard let extract = clarityExtractLumaKernel(),
              let combine = clarityCombineKernel() else {
            return input
        }
        guard let lumaSplat = extract.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [input]
        ) else {
            return input
        }
        let blurredLuma = applySeparableGaussianBlur(to: lumaSplat, radius: radius)
        return combine.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [input, blurredLuma, amount]
        ) ?? input
    }

    // MARK: SceneNRLuminance (Plan 2 v2 v2 M3a)

    /// Apply scene-linear Rec.2020 luminance noise reduction (Oklab
    /// roundtrip + shared blur on the L channel). Mirrors
    /// `noise_reduction::apply_luminance` from raw-core/src/stages/
    /// noise_reduction.rs:20-55.
    ///
    /// `nrLuminance` is in [0, 100]; 0 is identity (short-circuit at
    /// |amount| < 1e-3 mirrors noise_reduction.rs:22). Higher values
    /// scale the integer blur radius via `radius = max(1, ceil((amount
    /// / 100) * 2.0))` — matching the Rust integer math at
    /// noise_reduction.rs:24-25 byte-for-byte. Maximum effective radius
    /// at amount=100 is 2 source pixels (3-pass box ~3 px tail), well
    /// inside the Deep Zoom 35 px overlap budget.
    ///
    /// Composition: extractL runs first (one CIColorKernel.apply,
    /// rec2020 -> oklab and splat L -> (L, L, L, alpha)), then
    /// applySeparableGaussianBlur runs at the integer radius, then
    /// combine runs (one CIColorKernel.apply, original rec2020 +
    /// blurred-L -> rec2020 with new L). Three downstream `apply`
    /// calls per slider tick — same shape as Plan 2 v2 v1's
    /// applySceneClarity (two applies: blur + sceneUnsharp), with
    /// the additional extract step to splat L into 3 channels.
    public static func applySceneNRLuminance(
        to input: CIImage,
        nrLuminance: Float
    ) -> CIImage {
        if abs(nrLuminance) < 1e-3 { return input }
        // Integer radius mirrors noise_reduction.rs:24-25 byte-for-byte.
        let scaled = (nrLuminance / 100.0) * 2.0
        let ceiled = Int(ceilf(scaled))
        let radius = max(1, ceiled)

        guard let extract = sceneNRLuminanceExtractKernel(),
              let combine = sceneNRLuminanceCombineKernel() else {
            return input
        }

        // Step 1: rec2020 -> oklab -> (L, L, L, alpha) on full extent.
        guard let lOnly = extract.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [input]
        ) else { return input }

        // Step 2: blur the L plane at integer radius (shared compute
        // kernel; the wrapper short-circuits to `lOnly` on radius == 0
        // but we already filtered amount==0 above, so radius >= 1).
        let blurredL = applySeparableGaussianBlur(to: lOnly, radius: radius)

        // Step 3: combine — sample original rec2020 + blurred L; emit
        // rec2020 with new L. The `amount` arg is unused inside the
        // combine kernel (see SceneNRLuminance.metal header comment).
        return combine.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [input, blurredL, nrLuminance / 100.0]
        ) ?? input
    }

    // MARK: SceneNRColor (Plan 2 v2 v2 M3b)

    /// Apply scene-linear Rec.2020 chroma noise reduction (Oklab
    /// roundtrip + shared blur on the a/b channels). Mirrors
    /// `noise_reduction::apply_color` from raw-core/src/stages/
    /// noise_reduction.rs:61-96.
    ///
    /// `nrColor` is in [0, 100]; 0 is identity. The default
    /// `AdjustmentModel.nrColor` is 25 (radius=1), so this wrapper
    /// runs by default — meaning AdjustmentModel.default produces
    /// chroma-blurred output with one box-blur radius. Higher slider
    /// values scale the integer blur radius via `radius = max(1,
    /// ceil((amount / 100) * 4.0))`. Maximum effective radius at
    /// amount=100 is 4 source pixels (3-pass box ~3 px tail), well
    /// inside the Deep Zoom 35 px overlap budget.
    ///
    /// Composition: same shape as applySceneNRLuminance — extractAB
    /// runs first (rec2020 -> oklab and pack (a, b, 0, alpha)), then
    /// applySeparableGaussianBlur at the integer radius, then combine
    /// (rec2020 + blurred-AB -> rec2020 with new a/b).
    public static func applySceneNRColor(
        to input: CIImage,
        nrColor: Float
    ) -> CIImage {
        if abs(nrColor) < 1e-3 { return input }
        let scaled = (nrColor / 100.0) * 4.0
        let ceiled = Int(ceilf(scaled))
        let radius = max(1, ceiled)

        guard let extract = sceneNRColorExtractKernel(),
              let combine = sceneNRColorCombineKernel() else {
            return input
        }

        guard let abPlane = extract.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [input]
        ) else { return input }

        let blurredAB = applySeparableGaussianBlur(to: abPlane, radius: radius)

        return combine.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [input, blurredAB, nrColor / 100.0]
        ) ?? input
    }

    // MARK: SceneDehaze (Plan 2 v2 v4 M5)

    /// Apply scene-linear Rec.2020 dehaze. Mirrors `dehaze::apply` from
    /// raw-core/src/stages/dehaze.rs:144-179.
    ///
    /// `dehaze` is in [-100, +100]; 0 is identity (short-circuit at
    /// |dehaze| < 1e-3 mirrors dehaze.rs:146). Positive removes haze;
    /// negative adds haze. The 67 px stencil (15x15 dark-channel + 60
    /// guided-filter box) exceeds Deep Zoom's 35 px overlap budget;
    /// the deep-zoom UI clamps maxPixelScale to fit-zoom when this
    /// slider is non-zero. See docs/superpowers/plans/2026-04-25-deep-
    /// zoom-tile-rendering.md Architecture point 3.
    ///
    /// Composition (single MTLCommandBuffer pair, with one CPU sync
    /// between them to sort the per-threadgroup partial buffer):
    ///   1. Render input CIImage to fp16 RGBA scratch (texSrc).
    ///   2. dehazeDarkChannel(texSrc -> texDark).
    ///   3. dehazeAtmoPartial (per-tg top-1 -> partialBuf).
    ///   4. CPU sync: read partialBuf, sort descending, write back.
    ///   5. dehazeAtmoFinal (-> atmoBuf, 3 floats).
    ///   6. dehazeBuildGuide(texSrc -> texGuide).
    ///   7. dehazeTransmission(texSrc, atmoBuf -> texTrans).
    ///   8. Guided filter on (texGuide, texTrans):
    ///      8a. dehaze single-pass box-blur of texGuide -> texMeanI.
    ///          NOT the v2 v1 SeparableGaussianBlur — see plan §
    ///          "Box-blur semantics for guided filter".
    ///      8b. box-blur of texTrans -> texMeanP.
    ///      8c. dehazeBuildIp(texGuide, texTrans -> texIp), box-blur ->
    ///          texMeanIp.
    ///      8d. dehazeBuildII(texGuide -> texII), box-blur -> texMeanII.
    ///      8e. dehazeCombineAB -> texPackedAB (rg16Float).
    ///      8f. dehazeUnpackR(texPackedAB -> texAUnpack), box-blur ->
    ///          texMeanA.
    ///      8g. dehazeUnpackG(texPackedAB -> texBUnpack), box-blur ->
    ///          texMeanB.
    ///   9. Wrap texSrc, texMeanA, texMeanB, texGuide as CIImages.
    ///  10. dehazeReconstruct CIColorKernel — final per-pixel J = (I-A)/
    ///      max(t_eff, 0.1) + A with slider mapping.
    ///
    /// Returns identity (the input CIImage instance unchanged) on:
    ///   - |dehaze| < 1e-3
    ///   - any kernel-load / pipeline-build / texture-alloc step fails
    ///     (silent fallback per the existing wrapper convention)
    public static func applySceneDehaze(
        to input: CIImage,
        dehaze: Float
    ) -> CIImage {
        if abs(dehaze) < 1e-3 { return input }
        let scale = max(-1.0, min(1.0, dehaze / 100.0))

        guard let device = metalDevice(),
              let queue = device.makeCommandQueue(),
              let pDark = dehazeDarkChannelPipeline(),
              let pAtmoPartial = dehazeAtmoPartialPipeline(),
              let pAtmoFinal = dehazeAtmoFinalPipeline(),
              let pTrans = dehazeTransmissionPipeline(),
              let pGuide = dehazeGuidePipeline(),
              let pBoxH = dehazeBoxBlurHPipeline(),
              let pBoxV = dehazeBoxBlurVPipeline(),
              let pBuildIp = dehazeBuildIpPipeline(),
              let pBuildII = dehazeBuildIIPipeline(),
              let pCombineAB = dehazeCombineABPipeline(),
              let pUnpackR = dehazeUnpackRPipeline(),
              let pUnpackG = dehazeUnpackGPipeline(),
              let kReconstruct = dehazeReconstructKernel() else {
            return input
        }

        let extent = input.extent
        let w = max(1, Int(extent.width.rounded()))
        let h = max(1, Int(extent.height.rounded()))

        // RGBA fp16 source render target.
        let descRGBA = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .rgba16Float, width: w, height: h, mipmapped: false)
        descRGBA.usage = [.shaderRead, .shaderWrite, .renderTarget]
        descRGBA.storageMode = .private

        // Single-channel fp16 scratch (.r16Float).
        let descSC = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .r16Float, width: w, height: h, mipmapped: false)
        descSC.usage = [.shaderRead, .shaderWrite]
        descSC.storageMode = .private

        // Two-channel fp16 packed (a, b).
        let descRG = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .rg16Float, width: w, height: h, mipmapped: false)
        descRG.usage = [.shaderRead, .shaderWrite]
        descRG.storageMode = .private

        guard let texSrc = device.makeTexture(descriptor: descRGBA),
              let texDark = device.makeTexture(descriptor: descSC),
              let texGuide = device.makeTexture(descriptor: descSC),
              let texTrans = device.makeTexture(descriptor: descSC),
              let texMeanI = device.makeTexture(descriptor: descSC),
              let texMeanP = device.makeTexture(descriptor: descSC),
              let texIp = device.makeTexture(descriptor: descSC),
              let texMeanIp = device.makeTexture(descriptor: descSC),
              let texII = device.makeTexture(descriptor: descSC),
              let texMeanII = device.makeTexture(descriptor: descSC),
              let texPackedAB = device.makeTexture(descriptor: descRG),
              let texAUnpack = device.makeTexture(descriptor: descSC),
              let texBUnpack = device.makeTexture(descriptor: descSC),
              let texMeanA = device.makeTexture(descriptor: descSC),
              let texMeanB = device.makeTexture(descriptor: descSC),
              let texPing = device.makeTexture(descriptor: descSC) else {
            return input
        }

        // Render input -> texSrc.
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        let ciCtx = CIContext(mtlDevice: device, options: [
            .workingColorSpace: CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!,
            .workingFormat: CIFormat.RGBAh,
            .cacheIntermediates: false,
        ])
        guard let cb1 = queue.makeCommandBuffer() else { return input }
        ciCtx.render(input, to: texSrc, commandBuffer: cb1, bounds: extent, colorSpace: space)

        let tgX = (w + 15) / 16
        let tgY = (h + 15) / 16

        // Helper: dispatch a 2D compute kernel filling (w, h) with 16x16
        // threadgroup tiles. Returns false on encoder failure.
        func dispatch2D(
            _ pipeline: MTLComputePipelineState,
            on cb: MTLCommandBuffer,
            configure: (MTLComputeCommandEncoder) -> Void
        ) -> Bool {
            guard let enc = cb.makeComputeCommandEncoder() else { return false }
            enc.setComputePipelineState(pipeline)
            configure(enc)
            let tg = MTLSize(width: 16, height: 16, depth: 1)
            let tgCount = MTLSize(
                width:  tgX,
                height: tgY,
                depth: 1)
            enc.dispatchThreadgroups(tgCount, threadsPerThreadgroup: tg)
            enc.endEncoding()
            return true
        }

        // Box-blur helper: 1 H pass + 1 V pass via texPing scratch.
        // Reads from `srcTex`, writes to `dstTex`. (No 3-pass approximation —
        // dehaze guided filter expects single-pass running-sum.)
        let boxRadius: UInt32 = 60
        func boxBlurSingleChannel(
            _ srcTex: MTLTexture, _ dstTex: MTLTexture, on cb: MTLCommandBuffer
        ) -> Bool {
            // H pass: srcTex -> texPing.
            var radius = boxRadius
            guard dispatch2D(pBoxH, on: cb, configure: { enc in
                enc.setTexture(srcTex, index: 0)
                enc.setTexture(texPing, index: 1)
                enc.setBytes(&radius, length: 4, index: 0)
            }) else { return false }
            // V pass: texPing -> dstTex.
            return dispatch2D(pBoxV, on: cb, configure: { enc in
                enc.setTexture(texPing, index: 0)
                enc.setTexture(dstTex, index: 1)
                enc.setBytes(&radius, length: 4, index: 0)
            })
        }

        // 1. Dark channel.
        guard dispatch2D(pDark, on: cb1, configure: { enc in
            enc.setTexture(texSrc, index: 0)
            enc.setTexture(texDark, index: 1)
        }) else { return input }

        // 2. Atmospheric-light pass 1 (per-tg top-1).
        let partialCount = tgX * tgY
        let totalPixels = UInt32(w * h)
        let topN = max(UInt32(1), totalPixels / 1000)
        guard let partialBuf = device.makeBuffer(
            length: partialCount * MemoryLayout<SIMD4<Float>>.stride,
            options: .storageModeShared) else { return input }
        var partialDims = SIMD2<UInt32>(UInt32(tgX), UInt32(tgY))
        guard dispatch2D(pAtmoPartial, on: cb1, configure: { enc in
            enc.setTexture(texSrc, index: 0)
            enc.setTexture(texDark, index: 1)
            enc.setBuffer(partialBuf, offset: 0, index: 0)
            enc.setBytes(&partialDims, length: MemoryLayout<SIMD2<UInt32>>.size, index: 1)
        }) else { return input }

        // Commit cb1 and wait — we need to read partialBuf back, sort, then
        // dispatch the final reduce on cb2.
        cb1.commit()
        cb1.waitUntilCompleted()

        // CPU sort the partial buffer descending by .x (dark-channel value).
        let partialPtr = partialBuf.contents()
            .bindMemory(to: SIMD4<Float>.self, capacity: partialCount)
        var partials = Array(UnsafeBufferPointer(start: partialPtr, count: partialCount))
        partials.sort { $0.x > $1.x }
        for (i, v) in partials.enumerated() { partialPtr[i] = v }

        // Build atmoBuf (3 floats output).
        guard let atmoBuf = device.makeBuffer(
            length: 3 * MemoryLayout<Float>.stride,
            options: .storageModeShared) else { return input }

        // 3. Atmospheric-light pass 2 (final reduce).
        guard let cb2 = queue.makeCommandBuffer() else { return input }
        var partialCountU32 = UInt32(partialCount)
        var topNU32 = topN
        guard let encAtmo = cb2.makeComputeCommandEncoder() else { return input }
        encAtmo.setComputePipelineState(pAtmoFinal)
        encAtmo.setBuffer(partialBuf, offset: 0, index: 0)
        encAtmo.setBuffer(atmoBuf,    offset: 0, index: 1)
        encAtmo.setBytes(&partialCountU32, length: 4, index: 2)
        encAtmo.setBytes(&topNU32, length: 4, index: 3)
        encAtmo.dispatchThreadgroups(
            MTLSize(width: 1, height: 1, depth: 1),
            threadsPerThreadgroup: MTLSize(width: 1, height: 1, depth: 1))
        encAtmo.endEncoding()

        // 4. Guide.
        guard dispatch2D(pGuide, on: cb2, configure: { enc in
            enc.setTexture(texSrc, index: 0)
            enc.setTexture(texGuide, index: 1)
        }) else { return input }

        // 5. Transmission.
        guard dispatch2D(pTrans, on: cb2, configure: { enc in
            enc.setTexture(texSrc, index: 0)
            enc.setTexture(texTrans, index: 1)
            enc.setBuffer(atmoBuf, offset: 0, index: 0)
        }) else { return input }

        // 6. Guided filter — 8 box-blurs + build_Ip + build_II + combineAB
        //    + unpack R/G.
        guard boxBlurSingleChannel(texGuide, texMeanI, on: cb2) else { return input }
        guard boxBlurSingleChannel(texTrans, texMeanP, on: cb2) else { return input }
        guard dispatch2D(pBuildIp, on: cb2, configure: { enc in
            enc.setTexture(texGuide, index: 0)
            enc.setTexture(texTrans, index: 1)
            enc.setTexture(texIp, index: 2)
        }) else { return input }
        guard boxBlurSingleChannel(texIp, texMeanIp, on: cb2) else { return input }
        guard dispatch2D(pBuildII, on: cb2, configure: { enc in
            enc.setTexture(texGuide, index: 0)
            enc.setTexture(texII, index: 1)
        }) else { return input }
        guard boxBlurSingleChannel(texII, texMeanII, on: cb2) else { return input }
        var eps: Float = 1e-3
        guard dispatch2D(pCombineAB, on: cb2, configure: { enc in
            enc.setTexture(texMeanI, index: 0)
            enc.setTexture(texMeanP, index: 1)
            enc.setTexture(texMeanIp, index: 2)
            enc.setTexture(texMeanII, index: 3)
            enc.setTexture(texPackedAB, index: 4)
            enc.setBytes(&eps, length: 4, index: 0)
        }) else { return input }
        // Unpack a -> single-channel scratch, then box-blur into texMeanA.
        guard dispatch2D(pUnpackR, on: cb2, configure: { enc in
            enc.setTexture(texPackedAB, index: 0)
            enc.setTexture(texAUnpack, index: 1)
        }) else { return input }
        guard boxBlurSingleChannel(texAUnpack, texMeanA, on: cb2) else { return input }
        // Unpack b -> single-channel scratch, then box-blur into texMeanB.
        guard dispatch2D(pUnpackG, on: cb2, configure: { enc in
            enc.setTexture(texPackedAB, index: 0)
            enc.setTexture(texBUnpack, index: 1)
        }) else { return input }
        guard boxBlurSingleChannel(texBUnpack, texMeanB, on: cb2) else { return input }

        cb2.commit()
        cb2.waitUntilCompleted()
        // We need atmoBuf to be visible on CPU before we read A_r/A_g/A_b
        // for the CIColorKernel arguments, hence the wait.

        // 7. Reconstruction CIColorKernel.
        // Wrap the 4 outputs as CIImages (texSrc, texMeanA, texMeanB, texGuide).
        let opts: [CIImageOption: Any] = [.colorSpace: space]
        guard let imgSrc = CIImage(mtlTexture: texSrc, options: opts),
              let imgMeanA = CIImage(mtlTexture: texMeanA, options: opts),
              let imgMeanB = CIImage(mtlTexture: texMeanB, options: opts),
              let imgGuide = CIImage(mtlTexture: texGuide, options: opts) else {
            return input
        }

        let atmoPtr = atmoBuf.contents().bindMemory(to: Float.self, capacity: 3)
        let A_r = atmoPtr[0]
        let A_g = atmoPtr[1]
        let A_b = atmoPtr[2]

        return kReconstruct.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [imgSrc, imgMeanA, imgMeanB, imgGuide, A_r, A_g, A_b, scale]
        ) ?? input
    }

    // MARK: SceneSharpen (Plan 2 v2 v3 M4)

    /// Apply scene-linear Rec.2020 capture sharpening (3-iteration
    /// Richardson-Lucy with Gaussian PSF + edge-aware mix). Mirrors
    /// `sharpen::apply` from raw-core/src/stages/sharpen.rs:22-124.
    ///
    /// Slider params (per AdjustmentModel.swift:47-50, mirroring xmp.rs:
    /// 35-38):
    ///   * amount: 0..150, default 0. 0 skips, 100 is full RL, >100 adds
    ///     unsharp overdrive.
    ///   * radius: 0.5..3.0, default 0.5. PSF Gaussian sigma; converted
    ///     to integer box radius via clamp(0.5, 3.0).round().max(1)
    ///     mirroring sharpen.rs:33-34.
    ///   * detail: 0..100, default 25. Edge-attenuation strength.
    ///   * masking: 0..100, default 0. Edge-mask threshold.
    ///
    /// Short-circuits to identity when |amount| < 1e-3 mirroring
    /// sharpen.rs:30.
    ///
    /// **Task 2 partial implementation:** RL iterations only. Overdrive
    /// (amount > 100, Task 4) and edge-aware mix (Task 3) are not yet
    /// applied — the wrapper returns the post-RL `sharpened` directly
    /// (equivalent to amount=100, masking=0, detail=irrelevant). This is
    /// a stepping stone; Tasks 3 + 4 layer on the missing pieces.
    public static func applySceneSharpen(
        to input: CIImage,
        amount: Float,
        radius: Float,
        detail: Float,
        masking: Float
    ) -> CIImage {
        if abs(amount) < 1e-3 { return input }

        // Integer radius mirrors sharpen.rs:33-34 byte-for-byte:
        //   radius_px = radius.clamp(0.5, 3.0).round() as usize;
        //   let radius_px = radius_px.max(1);
        let clamped = max(0.5, min(3.0, radius))
        let rounded = Int(roundf(clamped))
        let radiusPx = max(1, rounded)

        guard let ratioKernel = rlRatioKernel(),
              let multiplyKernel = rlMultiplyKernel() else {
            return input
        }

        // Task 2: 3 iterations of Richardson-Lucy. observed = input,
        // estimate starts as input; after 3 iters, sharpened = estimate.
        let observed = input
        var estimate = input

        for _ in 0..<3 {
            // reblur = blur(estimate, radius_px)
            let reblur = applySeparableGaussianBlur(to: estimate, radius: radiusPx)
            // ratio = observed / max(reblur, EPSILON)
            guard let ratio = ratioKernel.apply(
                extent: input.extent,
                roiCallback: { _, rect in rect },
                arguments: [observed, reblur]
            ) else { return input }
            // correction = blur(ratio, radius_px)
            let correction = applySeparableGaussianBlur(to: ratio, radius: radiusPx)
            // estimate = estimate * correction
            guard let nextEstimate = multiplyKernel.apply(
                extent: input.extent,
                roiCallback: { _, rect in rect },
                arguments: [estimate, correction]
            ) else { return input }
            estimate = nextEstimate
        }

        // Tasks 3 + 4: overdrive + edge-aware mix.
        var sharpened = estimate

        // Task 4 — overdrive (amount > 100). Per sharpen.rs:65-76.
        if amount > 100.0 {
            if let overdriveKernel = sharpenOverdriveKernel() {
                let overMix = (amount - 100.0) / 100.0
                let blurredEstimate = applySeparableGaussianBlur(
                    to: sharpened, radius: radiusPx
                )
                if let overdriven = overdriveKernel.apply(
                    extent: input.extent,
                    roiCallback: { _, rect in rect },
                    arguments: [sharpened, blurredEstimate, overMix]
                ) {
                    sharpened = overdriven
                }
                // If the kernel-load or apply step fails, fall through
                // with the un-overdriven sharpened. Silent fallback per
                // the existing wrapper convention.
            }
        }

        // Task 3 — edge-aware mix.
        guard let lumaKernel = sharpenLuminanceKernel(),
              let mixKernel = sharpenEdgeMixKernel() else {
            return sharpened
        }

        let overallMix = max(0.0, min(1.5, amount / 100.0))
        let detailAtten = max(0.0, min(1.0, detail / 100.0))
        let maskingThreshold = max(0.0, min(1.0, masking / 100.0))

        // Step 1: extract Rec.2020 BT.2020 luma from observed.
        guard let lumaPlane = lumaKernel.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [observed]
        ) else { return sharpened }

        // Step 2: edge-aware mix.
        return mixKernel.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [
                observed,
                sharpened,
                lumaPlane,
                overallMix,
                detailAtten,
                maskingThreshold,
            ]
        ) ?? sharpened
    }

    /// Shared per-pixel mix kernel: `out = src + (src - blurred) * amount`.
    /// Used by `applySceneClarity` and `applySceneTexture` — the only
    /// difference between the two stages is the upstream blur's radius.
    /// Mirrors clarity.rs:16-20 and texture.rs:16-20 byte-for-byte (the
    /// two are byte-identical at the per-pixel mix level; the diff is
    /// confirmed in Task 4 Step 4.1 of the plan).
    private static func applySceneUnsharp(
        to input: CIImage,
        blurred: CIImage,
        amount: Float
    ) -> CIImage {
        guard let kernel = sceneUnsharpKernel() else { return input }
        return kernel.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [input, blurred, amount]
        ) ?? input
    }

    private static func sceneUnsharpKernel() -> CIKernel? {
        if let k = _sceneUnsharp { return k }
        _sceneUnsharp = loadKernel(file: "SceneUnsharp",
                                   function: "sceneUnsharp")
        return _sceneUnsharp
    }

    /// Loaders for the Ticket 11 Bug B luma-space clarity / texture
    /// kernels. Both functions live in SceneClarity.metal (extractLuma
    /// + combine). Same `loadKernel(file:function:)` pattern as the
    /// other kernel sources; cached for the process lifetime.
    private static func clarityExtractLumaKernel() -> CIKernel? {
        if let k = _clarityExtractLuma { return k }
        _clarityExtractLuma = loadKernel(file: "SceneClarity",
                                         function: "clarityExtractLuma")
        return _clarityExtractLuma
    }

    private static func clarityCombineKernel() -> CIKernel? {
        if let k = _clarityCombine { return k }
        _clarityCombine = loadKernel(file: "SceneClarity",
                                     function: "clarityCombine")
        return _clarityCombine
    }

    private static func sceneNRLuminanceExtractKernel() -> CIKernel? {
        if let k = _sceneNRLuminanceExtract { return k }
        _sceneNRLuminanceExtract = loadKernel(file: "SceneNRLuminance",
                                              function: "nrLuminanceExtractL")
        return _sceneNRLuminanceExtract
    }

    private static func sceneNRLuminanceCombineKernel() -> CIKernel? {
        if let k = _sceneNRLuminanceCombine { return k }
        _sceneNRLuminanceCombine = loadKernel(file: "SceneNRLuminance",
                                              function: "nrLuminanceCombine")
        return _sceneNRLuminanceCombine
    }

    private static func sceneNRColorExtractKernel() -> CIKernel? {
        if let k = _sceneNRColorExtract { return k }
        _sceneNRColorExtract = loadKernel(file: "SceneNRColor",
                                          function: "nrColorExtractAB")
        return _sceneNRColorExtract
    }

    private static func sceneNRColorCombineKernel() -> CIKernel? {
        if let k = _sceneNRColorCombine { return k }
        _sceneNRColorCombine = loadKernel(file: "SceneNRColor",
                                          function: "nrColorCombine")
        return _sceneNRColorCombine
    }

    // MARK: Sharpen kernel loaders (Plan 2 v2 v3 M4)

    private static func rlRatioKernel() -> CIKernel? {
        if let k = _rlRatio { return k }
        _rlRatio = loadKernel(file: "RichardsonLucyMixer",
                              function: "rlRatio")
        return _rlRatio
    }

    private static func rlMultiplyKernel() -> CIKernel? {
        if let k = _rlMultiply { return k }
        _rlMultiply = loadKernel(file: "RichardsonLucyMixer",
                                 function: "rlMultiply")
        return _rlMultiply
    }

    private static func sharpenLuminanceKernel() -> CIKernel? {
        if let k = _sharpenLuminance { return k }
        _sharpenLuminance = loadKernel(file: "SharpenEdgeMix",
                                       function: "sharpenLuminance")
        return _sharpenLuminance
    }

    private static func sharpenEdgeMixKernel() -> CIKernel? {
        if let k = _sharpenEdgeMix { return k }
        // `sharpenEdgeMix` does neighbour sampling on `luma`, which
        // requires CIKernel (spatial). Per Task 3 Step 3.1 spike result.
        _sharpenEdgeMix = loadKernel(file: "SharpenEdgeMix",
                                     function: "sharpenEdgeMix")
        return _sharpenEdgeMix
    }

    private static func sharpenOverdriveKernel() -> CIKernel? {
        if let k = _sharpenOverdrive { return k }
        _sharpenOverdrive = loadKernel(file: "SharpenOverdrive",
                                       function: "sharpenOverdrive")
        return _sharpenOverdrive
    }

    // MARK: Private kernel loaders
    //
    // These kernels are defined in `.metal` source files using CoreImage's
    // `coreimage::` namespace, which Xcode's Metal compiler doesn't recognise
    // — so Package.swift declares the Metal directory with `.copy("Metal")`
    // (verbatim file copy, no build-time compilation). At runtime we load
    // the source text and compile via `CIKernel.kernels(withMetalString:)`,
    // then pluck the named kernel out of the result.
    //
    // Slot type is intentionally `CIKernel?` — see the file header for why
    // a `CIColorKernel` cast here would silently null the slot for every
    // `sampler_h`-based kernel in this module.

    private static func sceneToneControlsKernel() -> CIKernel? {
        if let k = _sceneToneControls { return k }
        _sceneToneControls = loadKernel(file: "SceneToneControls",
                                        function: "sceneToneControls")
        return _sceneToneControls
    }

    private static func sceneVibranceKernel() -> CIKernel? {
        if let k = _sceneVibrance { return k }
        _sceneVibrance = loadKernel(file: "SceneVibrance",
                                    function: "sceneVibrance")
        return _sceneVibrance
    }

    private static func whiteBalanceKernel() -> CIKernel? {
        if let k = _whiteBalance { return k }
        _whiteBalance = loadKernel(file: "WhiteBalance",
                                   function: "whiteBalance")
        return _whiteBalance
    }

    private static func sceneSaturationKernel() -> CIKernel? {
        if let k = _sceneSaturation { return k }
        _sceneSaturation = loadKernel(file: "SceneSaturation",
                                      function: "sceneSaturation")
        return _sceneSaturation
    }

    public static func agxKernel() -> CIKernel? {
        if let k = _agxViewTransform { return k }
        _agxViewTransform = loadKernel(file: "AgXViewTransform",
                                       function: "agxViewTransform")
        return _agxViewTransform
    }

    // MARK: SeparableGaussianBlur — private helpers

    /// Cached default Metal device. Same lazy / process-lifetime cache
    /// pattern as the CIKernel slots above.
    private static func metalDevice() -> MTLDevice? {
        if let d = _metalDevice { return d }
        _metalDevice = MTLCreateSystemDefaultDevice()
        return _metalDevice
    }

    /// Compile `SeparableGaussianBlur.metal` to a runtime `MTLLibrary`.
    /// Source comes from `Bundle.module/Metal/` (verbatim copy via
    /// Package.swift `.copy("Metal")`). The pipeline path differs from
    /// the CIKernel sources above: this uses
    /// `MTLDevice.makeLibrary(source:options:)`, not
    /// `CIKernel.kernels(withMetalString:)`. Same source-text input,
    /// different downstream consumer.
    private static func separableGaussianBlurLibrary() -> MTLLibrary? {
        if let lib = _separableGaussianBlurLib { return lib }
        guard let device = metalDevice(),
              let data = metalSource("SeparableGaussianBlur"),
              let source = String(data: data, encoding: .utf8) else {
            os_log(.error, log: kernelLog,
                "SeparableGaussianBlur.metal source not found in Bundle.module/Metal/")
            return nil
        }
        do {
            _separableGaussianBlurLib = try device.makeLibrary(source: source, options: nil)
            return _separableGaussianBlurLib
        } catch {
            os_log(.error, log: kernelLog,
                "MTLDevice.makeLibrary(source:) failed for SeparableGaussianBlur: %{public}@",
                String(describing: error))
            return nil
        }
    }

    private static func separableBoxBlurHPipeline() -> MTLComputePipelineState? {
        if let p = _separableBoxBlurHPipeline { return p }
        guard let device = metalDevice(),
              let lib = separableGaussianBlurLibrary(),
              let fn = lib.makeFunction(name: "separableBoxBlurH") else {
            os_log(.error, log: kernelLog,
                "separableBoxBlurH function missing from compiled library")
            return nil
        }
        do {
            _separableBoxBlurHPipeline = try device.makeComputePipelineState(function: fn)
        } catch {
            os_log(.error, log: kernelLog,
                "makeComputePipelineState(separableBoxBlurH) failed: %{public}@",
                String(describing: error))
            return nil
        }
        return _separableBoxBlurHPipeline
    }

    private static func separableBoxBlurVPipeline() -> MTLComputePipelineState? {
        if let p = _separableBoxBlurVPipeline { return p }
        guard let device = metalDevice(),
              let lib = separableGaussianBlurLibrary(),
              let fn = lib.makeFunction(name: "separableBoxBlurV") else {
            os_log(.error, log: kernelLog,
                "separableBoxBlurV function missing from compiled library")
            return nil
        }
        do {
            _separableBoxBlurVPipeline = try device.makeComputePipelineState(function: fn)
        } catch {
            os_log(.error, log: kernelLog,
                "makeComputePipelineState(separableBoxBlurV) failed: %{public}@",
                String(describing: error))
            return nil
        }
        return _separableBoxBlurVPipeline
    }

    // MARK: Dehaze — private library loaders (Plan 2 v2 v4)

    /// Compile DehazeDarkChannel + DehazeAtmosphericLight + DehazeTransmission
    /// to a single runtime `MTLLibrary`. Source comes from `Bundle.module/
    /// Metal/` (verbatim copy via Package.swift `.copy("Metal")`). Three
    /// related kernels share one library so the Metal compiler can run a
    /// single compile invocation. Sources concatenated as plain text.
    private static func dehazeDarkAtmoTransLibrary() -> MTLLibrary? {
        if let lib = _dehazeDarkAtmoTransLib { return lib }
        guard let device = metalDevice() else { return nil }
        let parts = ["DehazeDarkChannel", "DehazeAtmosphericLight", "DehazeTransmission"]
        var joined = ""
        for name in parts {
            guard let data = metalSource(name),
                  let s = String(data: data, encoding: .utf8) else {
                os_log(.error, log: kernelLog,
                    "Dehaze .metal source %{public}@ not found in Bundle.module/Metal/", name)
                return nil
            }
            joined += s + "\n"
        }
        do {
            _dehazeDarkAtmoTransLib = try device.makeLibrary(source: joined, options: nil)
            return _dehazeDarkAtmoTransLib
        } catch {
            os_log(.error, log: kernelLog,
                "MTLDevice.makeLibrary(source:) failed for Dehaze dark-atmo-trans: %{public}@",
                String(describing: error))
            return nil
        }
    }

    private static func dehazeDarkChannelPipeline() -> MTLComputePipelineState? {
        if let p = _dehazeDarkChannelPipeline { return p }
        guard let device = metalDevice(),
              let lib = dehazeDarkAtmoTransLibrary(),
              let fn = lib.makeFunction(name: "dehazeDarkChannel") else {
            os_log(.error, log: kernelLog,
                "dehazeDarkChannel function missing from compiled library")
            return nil
        }
        do {
            _dehazeDarkChannelPipeline = try device.makeComputePipelineState(function: fn)
        } catch {
            os_log(.error, log: kernelLog,
                "makeComputePipelineState(dehazeDarkChannel) failed: %{public}@",
                String(describing: error))
            return nil
        }
        return _dehazeDarkChannelPipeline
    }

    private static func dehazeAtmoPartialPipeline() -> MTLComputePipelineState? {
        if let p = _dehazeAtmoPartialPipeline { return p }
        guard let device = metalDevice(),
              let lib = dehazeDarkAtmoTransLibrary(),
              let fn = lib.makeFunction(name: "dehazeAtmoPartial") else {
            os_log(.error, log: kernelLog,
                "dehazeAtmoPartial function missing from compiled library")
            return nil
        }
        do {
            _dehazeAtmoPartialPipeline = try device.makeComputePipelineState(function: fn)
        } catch {
            os_log(.error, log: kernelLog,
                "makeComputePipelineState(dehazeAtmoPartial) failed: %{public}@",
                String(describing: error))
            return nil
        }
        return _dehazeAtmoPartialPipeline
    }

    private static func dehazeAtmoFinalPipeline() -> MTLComputePipelineState? {
        if let p = _dehazeAtmoFinalPipeline { return p }
        guard let device = metalDevice(),
              let lib = dehazeDarkAtmoTransLibrary(),
              let fn = lib.makeFunction(name: "dehazeAtmoFinal") else {
            os_log(.error, log: kernelLog,
                "dehazeAtmoFinal function missing from compiled library")
            return nil
        }
        do {
            _dehazeAtmoFinalPipeline = try device.makeComputePipelineState(function: fn)
        } catch {
            os_log(.error, log: kernelLog,
                "makeComputePipelineState(dehazeAtmoFinal) failed: %{public}@",
                String(describing: error))
            return nil
        }
        return _dehazeAtmoFinalPipeline
    }

    private static func dehazeTransmissionPipeline() -> MTLComputePipelineState? {
        if let p = _dehazeTransmissionPipeline { return p }
        guard let device = metalDevice(),
              let lib = dehazeDarkAtmoTransLibrary(),
              let fn = lib.makeFunction(name: "dehazeTransmission") else {
            os_log(.error, log: kernelLog,
                "dehazeTransmission function missing from compiled library")
            return nil
        }
        do {
            _dehazeTransmissionPipeline = try device.makeComputePipelineState(function: fn)
        } catch {
            os_log(.error, log: kernelLog,
                "makeComputePipelineState(dehazeTransmission) failed: %{public}@",
                String(describing: error))
            return nil
        }
        return _dehazeTransmissionPipeline
    }

    private static func dehazeGuideLibrary() -> MTLLibrary? {
        if let lib = _dehazeGuideLib { return lib }
        guard let device = metalDevice(),
              let data = metalSource("DehazeGuide"),
              let source = String(data: data, encoding: .utf8) else {
            os_log(.error, log: kernelLog,
                "DehazeGuide.metal source not found in Bundle.module/Metal/")
            return nil
        }
        do {
            _dehazeGuideLib = try device.makeLibrary(source: source, options: nil)
            return _dehazeGuideLib
        } catch {
            os_log(.error, log: kernelLog,
                "MTLDevice.makeLibrary(source:) failed for DehazeGuide: %{public}@",
                String(describing: error))
            return nil
        }
    }

    private static func dehazeGuidePipeline() -> MTLComputePipelineState? {
        if let p = _dehazeGuidePipeline { return p }
        guard let device = metalDevice(),
              let lib = dehazeGuideLibrary(),
              let fn = lib.makeFunction(name: "dehazeBuildGuide") else {
            os_log(.error, log: kernelLog,
                "dehazeBuildGuide function missing from compiled library")
            return nil
        }
        do {
            _dehazeGuidePipeline = try device.makeComputePipelineState(function: fn)
        } catch {
            os_log(.error, log: kernelLog,
                "makeComputePipelineState(dehazeBuildGuide) failed: %{public}@",
                String(describing: error))
            return nil
        }
        return _dehazeGuidePipeline
    }

    private static func dehazeBoxBlurLibrary() -> MTLLibrary? {
        if let lib = _dehazeBoxBlurLib { return lib }
        guard let device = metalDevice(),
              let data = metalSource("DehazeBoxBlur"),
              let source = String(data: data, encoding: .utf8) else {
            os_log(.error, log: kernelLog,
                "DehazeBoxBlur.metal source not found in Bundle.module/Metal/")
            return nil
        }
        do {
            _dehazeBoxBlurLib = try device.makeLibrary(source: source, options: nil)
            return _dehazeBoxBlurLib
        } catch {
            os_log(.error, log: kernelLog,
                "MTLDevice.makeLibrary(source:) failed for DehazeBoxBlur: %{public}@",
                String(describing: error))
            return nil
        }
    }

    private static func dehazeBoxBlurHPipeline() -> MTLComputePipelineState? {
        if let p = _dehazeBoxBlurHPipeline { return p }
        guard let device = metalDevice(),
              let lib = dehazeBoxBlurLibrary(),
              let fn = lib.makeFunction(name: "dehazeBoxBlurH") else {
            os_log(.error, log: kernelLog,
                "dehazeBoxBlurH function missing from compiled library")
            return nil
        }
        do {
            _dehazeBoxBlurHPipeline = try device.makeComputePipelineState(function: fn)
        } catch {
            os_log(.error, log: kernelLog,
                "makeComputePipelineState(dehazeBoxBlurH) failed: %{public}@",
                String(describing: error))
            return nil
        }
        return _dehazeBoxBlurHPipeline
    }

    private static func dehazeBoxBlurVPipeline() -> MTLComputePipelineState? {
        if let p = _dehazeBoxBlurVPipeline { return p }
        guard let device = metalDevice(),
              let lib = dehazeBoxBlurLibrary(),
              let fn = lib.makeFunction(name: "dehazeBoxBlurV") else {
            os_log(.error, log: kernelLog,
                "dehazeBoxBlurV function missing from compiled library")
            return nil
        }
        do {
            _dehazeBoxBlurVPipeline = try device.makeComputePipelineState(function: fn)
        } catch {
            os_log(.error, log: kernelLog,
                "makeComputePipelineState(dehazeBoxBlurV) failed: %{public}@",
                String(describing: error))
            return nil
        }
        return _dehazeBoxBlurVPipeline
    }

    private static func dehazeGuidedFilterLibrary() -> MTLLibrary? {
        if let lib = _dehazeGuidedFilterLib { return lib }
        guard let device = metalDevice(),
              let data = metalSource("DehazeGuidedFilter"),
              let source = String(data: data, encoding: .utf8) else {
            os_log(.error, log: kernelLog,
                "DehazeGuidedFilter.metal source not found in Bundle.module/Metal/")
            return nil
        }
        do {
            _dehazeGuidedFilterLib = try device.makeLibrary(source: source, options: nil)
            return _dehazeGuidedFilterLib
        } catch {
            os_log(.error, log: kernelLog,
                "MTLDevice.makeLibrary(source:) failed for DehazeGuidedFilter: %{public}@",
                String(describing: error))
            return nil
        }
    }

    private static func dehazeBuildIpPipeline() -> MTLComputePipelineState? {
        if let p = _dehazeBuildIpPipeline { return p }
        guard let device = metalDevice(),
              let lib = dehazeGuidedFilterLibrary(),
              let fn = lib.makeFunction(name: "dehazeBuildIp") else {
            os_log(.error, log: kernelLog,
                "dehazeBuildIp function missing from compiled library")
            return nil
        }
        do {
            _dehazeBuildIpPipeline = try device.makeComputePipelineState(function: fn)
        } catch {
            os_log(.error, log: kernelLog,
                "makeComputePipelineState(dehazeBuildIp) failed: %{public}@",
                String(describing: error))
            return nil
        }
        return _dehazeBuildIpPipeline
    }

    private static func dehazeBuildIIPipeline() -> MTLComputePipelineState? {
        if let p = _dehazeBuildIIPipeline { return p }
        guard let device = metalDevice(),
              let lib = dehazeGuidedFilterLibrary(),
              let fn = lib.makeFunction(name: "dehazeBuildII") else {
            os_log(.error, log: kernelLog,
                "dehazeBuildII function missing from compiled library")
            return nil
        }
        do {
            _dehazeBuildIIPipeline = try device.makeComputePipelineState(function: fn)
        } catch {
            os_log(.error, log: kernelLog,
                "makeComputePipelineState(dehazeBuildII) failed: %{public}@",
                String(describing: error))
            return nil
        }
        return _dehazeBuildIIPipeline
    }

    private static func dehazeCombineABPipeline() -> MTLComputePipelineState? {
        if let p = _dehazeCombineABPipeline { return p }
        guard let device = metalDevice(),
              let lib = dehazeGuidedFilterLibrary(),
              let fn = lib.makeFunction(name: "dehazeCombineAB") else {
            os_log(.error, log: kernelLog,
                "dehazeCombineAB function missing from compiled library")
            return nil
        }
        do {
            _dehazeCombineABPipeline = try device.makeComputePipelineState(function: fn)
        } catch {
            os_log(.error, log: kernelLog,
                "makeComputePipelineState(dehazeCombineAB) failed: %{public}@",
                String(describing: error))
            return nil
        }
        return _dehazeCombineABPipeline
    }

    private static func dehazeUnpackRPipeline() -> MTLComputePipelineState? {
        if let p = _dehazeUnpackRPipeline { return p }
        guard let device = metalDevice(),
              let lib = dehazeGuidedFilterLibrary(),
              let fn = lib.makeFunction(name: "dehazeUnpackR") else {
            os_log(.error, log: kernelLog,
                "dehazeUnpackR function missing from compiled library")
            return nil
        }
        do {
            _dehazeUnpackRPipeline = try device.makeComputePipelineState(function: fn)
        } catch {
            os_log(.error, log: kernelLog,
                "makeComputePipelineState(dehazeUnpackR) failed: %{public}@",
                String(describing: error))
            return nil
        }
        return _dehazeUnpackRPipeline
    }

    private static func dehazeUnpackGPipeline() -> MTLComputePipelineState? {
        if let p = _dehazeUnpackGPipeline { return p }
        guard let device = metalDevice(),
              let lib = dehazeGuidedFilterLibrary(),
              let fn = lib.makeFunction(name: "dehazeUnpackG") else {
            os_log(.error, log: kernelLog,
                "dehazeUnpackG function missing from compiled library")
            return nil
        }
        do {
            _dehazeUnpackGPipeline = try device.makeComputePipelineState(function: fn)
        } catch {
            os_log(.error, log: kernelLog,
                "makeComputePipelineState(dehazeUnpackG) failed: %{public}@",
                String(describing: error))
            return nil
        }
        return _dehazeUnpackGPipeline
    }

    private static func dehazeReconstructKernel() -> CIKernel? {
        if let k = _dehazeReconstruct { return k }
        _dehazeReconstruct = loadKernel(file: "DehazeReconstruct",
                                        function: "dehazeReconstruct")
        return _dehazeReconstruct
    }

    // MARK: Helpers

    /// Load + runtime-compile one named CIKernel from a `.metal` source file
    /// bundled under `Metal/` via `.copy("Metal")` in Package.swift.
    /// Returns nil if the file is missing, the source can't be decoded as
    /// UTF-8, the Metal compiler rejects the source, or the named function
    /// isn't found in the resulting kernel list.
    private static func loadKernel(file: String, function: String) -> CIKernel? {
        guard let data = metalSource(file),
              let source = String(data: data, encoding: .utf8) else {
            os_log(.error, log: kernelLog,
                "Metal source file %{public}@.metal not found in bundle (Bundle.module/Metal/).",
                file)
            return nil
        }
        let kernels: [CIKernel]
        do {
            kernels = try CIKernel.kernels(withMetalString: source)
        } catch {
            os_log(.error, log: kernelLog,
                "CIKernel.kernels(withMetalString:) failed for %{public}@: %{public}@",
                file, String(describing: error))
            return nil
        }
        guard let match = kernels.first(where: { $0.name == function }) else {
            os_log(.error, log: kernelLog,
                "Metal source %{public}@ compiled, but no kernel named %{public}@ found (have: %{public}@)",
                file, function, kernels.map(\.name).joined(separator: ", "))
            return nil
        }
        return match
    }

    /// Load `.metal` source text from the bundle. SwiftPM's `.copy("Metal")`
    /// places the directory under `Bundle.module/Metal/`; an old-shape
    /// flat-bundle layout is also honoured as a fallback.
    private static func metalSource(_ name: String) -> Data? {
        let bundle = Bundle.module
        if let url = bundle.url(forResource: name, withExtension: "metal", subdirectory: "Metal") {
            return try? Data(contentsOf: url)
        }
        if let url = bundle.url(forResource: name, withExtension: "metal") {
            return try? Data(contentsOf: url)
        }
        return nil
    }

    // MARK: AgX LUT

    /// Build a 1×512 CIImage from the embedded agx_lut.bin (f32 LE).
    /// This is the same binary the Rust pipeline uses (AGX_VERSION 5).
    /// Both LUTs are emitted by `src/scripts/derive_agx_lut.py` — pass
    /// `--apple-bin` to that script to keep the Apple-bundled mirror in
    /// sync with the Rust raw-core source of truth.
    public static func agxLUTImage() -> CIImage? {
        guard let url = Bundle.module.url(forResource: "agx_lut", withExtension: "bin"),
              let data = try? Data(contentsOf: url) else {
            return agxLUTFallback()
        }
        return agxLUTImage(from: data)
    }

    /// Raw bytes of the embedded agx_lut.bin (f32 LE, 512 entries = 2048 bytes).
    /// Exposed so tests outside the `MapleCore` module can load the same
    /// LUT binary the Rust + Metal paths use; `Bundle.module` in a test
    /// target points at the test bundle, not at MapleCore's resource bundle.
    /// Tries `Metal/agx_lut.bin` (where SwiftPM's `.copy("Metal")` lands it)
    /// then bundle-root as a fallback for hand-bundled deployments.
    public static func agxLUTBytes() -> Data? {
        if let url = Bundle.module.url(
            forResource: "agx_lut", withExtension: "bin", subdirectory: "Metal"
        ) {
            return try? Data(contentsOf: url)
        }
        if let url = Bundle.module.url(
            forResource: "agx_lut", withExtension: "bin"
        ) {
            return try? Data(contentsOf: url)
        }
        return nil
    }

    private static func agxLUTImage(from data: Data) -> CIImage? {
        let count = data.count / 4
        guard count > 0 else { return nil }
        var pixels = [Float32](repeating: 0, count: count)
        data.withUnsafeBytes { ptr in
            guard let base = ptr.baseAddress else { return }
            pixels.withUnsafeMutableBytes { dst in
                dst.baseAddress?.copyMemory(from: base, byteCount: data.count)
            }
        }
        // Build as a 1-component float image for sampling in Metal.
        return pixels.withUnsafeMutableBytes { raw in
            let dp = CGDataProvider(data: Data(raw) as CFData)!
            let cs = CGColorSpaceCreateDeviceGray()
            if let cg = CGImage(width: count, height: 1,
                                bitsPerComponent: 32,
                                bitsPerPixel: 32,
                                bytesPerRow: count * 4,
                                space: cs,
                                bitmapInfo: CGBitmapInfo(rawValue: CGBitmapInfo.floatComponents.rawValue | CGImageAlphaInfo.none.rawValue),
                                provider: dp,
                                decode: nil,
                                shouldInterpolate: false,
                                intent: .defaultIntent) {
                return CIImage(cgImage: cg)
            }
            return nil
        }
    }

    /// Fallback LUT if the binary resource is absent: a linear-to-linear
    /// identity (no tone-mapping). This keeps builds working without the
    /// full asset bundle.
    private static func agxLUTFallback() -> CIImage? {
        let size = 512
        var pixels = [Float32](repeating: 0, count: size)
        for i in 0..<size { pixels[i] = Float(i) / Float(size - 1) }
        return pixels.withUnsafeMutableBytes { raw in
            let dp = CGDataProvider(data: Data(raw) as CFData)!
            let cs = CGColorSpaceCreateDeviceGray()
            guard let cg = CGImage(width: size, height: 1,
                                   bitsPerComponent: 32,
                                   bitsPerPixel: 32,
                                   bytesPerRow: size * 4,
                                   space: cs,
                                   bitmapInfo: CGBitmapInfo(rawValue:
                                       CGBitmapInfo.floatComponents.rawValue |
                                       CGImageAlphaInfo.none.rawValue),
                                   provider: dp,
                                   decode: nil,
                                   shouldInterpolate: false,
                                   intent: .defaultIntent) else { return nil }
            return CIImage(cgImage: cg)
        }
    }
}
