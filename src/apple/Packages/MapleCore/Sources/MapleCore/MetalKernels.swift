// MetalKernels.swift — Swift wrapper around the custom Metal CIKernels.
//
// Kernels are compiled from Metal source at app launch on first use.
//
// Scope (post-Option-C cleanup): only the production sharpen + nr_color
// path remains here. The 9 cheap-stage scene-linear kernels (white_balance,
// scene_tone_controls, vibrance, saturation, clarity, texture, dehaze,
// nr_luminance, AgX view transform) and their wrappers were retired when
// the Rust FFI gained `apply_scene_linear_chain` (see
// `pipeline.rs:apply_scene_linear_chain` and `ImageEditPipeline.swift:
// applySceneLinearChainViaFFI`). Apple now calls a single FFI from Swift
// for those stages; this file is the surviving GPU path for the two
// stages that stay on Metal because Rust-on-CPU exceeds the slider tick
// budget at viewport resolution: capture sharpen (Richardson-Lucy /
// luma USM, ~33 ms / 2 MP on CPU) and chroma noise reduction (Oklab
// a/b blur, ~5 ms / 2 MP on CPU).
//
// IMPORTANT: every cached kernel slot below is `CIKernel?`, never
// `CIColorKernel?`. All scene-linear kernels in this module use
// `coreimage::sampler_h` arguments (so they can sample at the source
// coord), which makes `CIKernel.kernels(withMetalString:)` return
// general `CIKernel` instances — NOT `CIColorKernel`. Casting those
// with `as? CIColorKernel` returns nil, and the wrapper functions
// silently `return input` — the user-visible symptom is that the
// affected slider becomes a no-op. Bug 2 in Ticket 12 was exactly
// this. Do not reintroduce the CIColorKernel cast for `sampler_h`
// kernels.
//
// Numeric tolerance per spec § 11 gate 4: ΔE ≤ 1.0 (≈ 1/255 in display).

import CoreImage
import Foundation
import Metal
import OSLog

private let kernelLog = OSLog(subsystem: "app.justmaple.maple", category: "MetalKernels")

// MARK: - MetalKernels (namespace)

public enum MetalKernels {
    // Kernels are compiled lazily on first access.
    //
    // Slot type is `CIKernel?` — see file header. `sampler_h`-based kernels
    // are returned by `CIKernel.kernels(withMetalString:)` as `CIKernel`,
    // not `CIColorKernel`; the `as? CIColorKernel` cast that used to live
    // in the loaders silently nulled them out and made every slider except
    // contrast a no-op (Bug 2 in Ticket 12).

    // SeparableGaussianBlur compute pipelines + shared helpers.
    // The blur is a `MTLComputePipeline` (not a `CIKernel`) because it
    // composes 6 stateful dispatches with ping-pong scratch textures.
    // Output is wrapped in a `CIImage` via `CIImage(mtlTexture:)` so the
    // downstream `CIKernel` chain (sharpen / nr_color wrappers) consumes
    // it like any other CIImage.
    private static var _separableGaussianBlurLib: MTLLibrary?
    private static var _separableBoxBlurHPipeline: MTLComputePipelineState?
    private static var _separableBoxBlurVPipeline: MTLComputePipelineState?
    /// Cached default Metal device — needed to build pipelines and
    /// allocate scratch textures. Lazy / process-lifetime cached, like
    /// the other kernel slots above.
    private static var _metalDevice: MTLDevice?

    // SceneNRColor shared kernels. Two kernels: extractAB (rec2020 ->
    // oklab a/b pack for the blur input) and combine (rec2020 +
    // blurredAB -> rec2020 with new a/b). Same lazy / process-lifetime
    // cache pattern.
    private static var _sceneNRColorExtract: CIKernel?
    private static var _sceneNRColorCombine: CIKernel?

    // SceneSharpen kernels:
    //   * sharpenLumaUSM: produces a full-strength sharpened buffer via
    //     luma-only unsharp mask (replaces 3-iter per-channel
    //     Richardson-Lucy + per-channel overdrive). Mirrors
    //     `raw-core/src/stages/sharpen.rs` byte-for-byte.
    //   * sharpenLuminance + sharpenEdgeMix: edge-aware final mix that
    //     applies the slider's amount/detail/masking on top of the
    //     full-strength sharpened buffer.
    private static var _sharpenLumaUSM: CIKernel?
    private static var _sharpenLuminance: CIKernel?
    // sharpenEdgeMix uses neighbour sampling on `luma`, which requires
    // the general (spatial) CIKernel — same slot type as everything else.
    private static var _sharpenEdgeMix: CIKernel?

    // MARK: SeparableGaussianBlur

    /// Apply the shared 3-pass box-blur Gaussian approximation (mirrors
    /// `gaussian_blur_rgb` in raw-core/src/stages/blur.rs) on a CIImage in
    /// scene-linear Rec.2020 fp16. Returns a new CIImage tagged
    /// extendedLinearITUR_2020. Used internally by `applySceneSharpen`
    /// (PSF blur) and `applySceneNRColor` (Oklab a/b blur).
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
    /// editor workloads (sharpen / nr_color only run when their slider
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

        let opts: [CIImageOption: Any] = [.colorSpace: space]
        return CIImage(mtlTexture: texPong, options: opts) ?? input
    }

    // MARK: SceneNRColor

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
    /// Composition: extractAB runs first (rec2020 -> oklab and pack
    /// (a, b, 0, alpha)), then applySeparableGaussianBlur at the integer
    /// radius, then combine (rec2020 + blurred-AB -> rec2020 with new
    /// a/b).
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

    // MARK: SceneSharpen

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
    /// sharpen.rs.
    ///
    /// Implementation: luminance-only unsharp mask, mirroring
    /// `raw-core/src/stages/sharpen.rs` byte-for-byte. Replaces the
    /// previous 3-iteration per-channel Richardson-Lucy + per-channel
    /// overdrive path that produced saturated chroma artifacts in
    /// shadow regions (the user-reported "blue specks in shadows" on
    /// test_0006). Luma USM scales every RGB channel at a pixel by
    /// the SAME factor, preserving chroma ratios by construction. The
    /// `SharpenLumaUSM.metal` kernel does the per-pixel math (BT.2020
    /// luma + smoothstep shadow guard + clamped scale); the existing
    /// `sharpenEdgeMix` then applies the slider's amount/detail/
    /// masking. The amount > 100 "overdrive" path is gone — the edge
    /// mix already supports `overallMix` up to 1.5×, and the prior
    /// per-channel overdrive reintroduced the same artifact class.
    public static func applySceneSharpen(
        to input: CIImage,
        amount: Float,
        radius: Float,
        detail: Float,
        masking: Float
    ) -> CIImage {
        if abs(amount) < 1e-3 { return input }

        // Integer radius mirrors sharpen.rs byte-for-byte:
        //   radius_px = radius.clamp(0.5, 3.0).round() as usize;
        //   let radius_px = radius_px.max(1);
        let clamped = max(0.5, min(3.0, radius))
        let rounded = Int(roundf(clamped))
        let radiusPx = max(1, rounded)

        guard let lumaUSMKernel = sharpenLumaUSMKernel() else {
            return input
        }

        let observed = input
        // Single Gaussian blur (replaces the 3-iter RL loop).
        let blurred = applySeparableGaussianBlur(to: observed, radius: radiusPx)
        // Full-strength sharpened buffer via luma-only USM. Slider
        // amount is applied below by `sharpenEdgeMix`, NOT here.
        guard let sharpened = lumaUSMKernel.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [observed, blurred]
        ) else { return input }

        // Edge-aware mix (amount + detail + masking).
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

    // MARK: Sharpen kernel loaders

    private static func sharpenLumaUSMKernel() -> CIKernel? {
        if let k = _sharpenLumaUSM { return k }
        _sharpenLumaUSM = loadKernel(file: "SharpenLumaUSM",
                                     function: "sharpenLumaUSM")
        return _sharpenLumaUSM
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
    //
    // The Apple AgX kernel has been retired (the Rust FFI now applies AgX
    // inside `apply_scene_linear_chain`), but the LUT binary is still
    // bundled and these accessors are kept for cross-platform parity tests
    // (`testAppleBundledAgxLUTMatchesRustLUT` in SceneLinearPipelineTests
    // still verifies the Apple-side LUT byte-matches the Rust-side LUT,
    // so a future Apple Metal AgX path — or a downstream consumer of the
    // bundled LUT — has a known-good source of truth).

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
