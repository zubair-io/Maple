// MetalKernels.swift — Swift wrapper around the custom CIColorKernels.
//
// Kernels are compiled from Metal source at app launch on first use.
// We use CIColorKernel for per-pixel operations (no sampling of adjacent
// pixels) and CIKernel for AgXViewTransform (which needs a LUT sampler).
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
    private static var _sceneToneControls: CIColorKernel?
    private static var _sceneVibrance: CIColorKernel?
    private static var _whiteBalance: CIColorKernel?
    private static var _sceneSaturation: CIColorKernel?
    private static var _agxViewTransform: CIKernel?

    // Plan 2 v2 — SeparableGaussianBlur compute pipelines + shared helpers.
    // The blur is a `MTLComputePipeline` (not a `CIKernel`) because it
    // composes 6 stateful dispatches with ping-pong scratch textures.
    // Output is wrapped in a `CIImage` via `CIImage(mtlTexture:)` so the
    // downstream `CIColorKernel` chain (clarity / texture wrappers, added
    // in Task 4) consumes it like any other CIImage. This compute → CI
    // handoff was verified by Spike 1.1.
    private static var _separableGaussianBlurLib: MTLLibrary?
    private static var _separableBoxBlurHPipeline: MTLComputePipelineState?
    private static var _separableBoxBlurVPipeline: MTLComputePipelineState?
    /// Cached default Metal device — needed to build pipelines and
    /// allocate scratch textures. Lazy / process-lifetime cached, like
    /// the other kernel slots above.
    private static var _metalDevice: MTLDevice?

    // Plan 2 v2 — SceneUnsharp shared mix kernel (Task 4). One CIColorKernel
    // mirrors the per-pixel `out = src + (src - blurred) * amount` mix from
    // raw-core/src/stages/clarity.rs:16-20 and texture.rs:16-20 (the two
    // Rust files are byte-identical at the mix level; only the upstream
    // blur radius differs). Loaded via the same `loadKernel(file:function:)`
    // path as the other CIColorKernel sources.
    private static var _sceneUnsharp: CIColorKernel?

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
        guard let lut = agxLUTImage() else {
            os_log(.error, log: kernelLog,
                "AgX LUT image failed to load — view transform NOT applied; output will be raw scene-linear data. Check that agx_lut.bin is bundled.")
            #if DEBUG
            if !isRunningUnderXCTest {
                assertionFailure("AgX LUT must load — see os_log .error above")
            }
            #endif
            return input
        }

        guard let out = kernel.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [input, lut, contrast]
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

    /// Apply scene-linear Rec.2020 clarity (unsharp mask at radius 40).
    /// Mirrors `clarity::apply` from raw-core/src/stages/clarity.rs:10.
    /// `clarity` is in [-100, +100]; 0 is identity (short-circuit at
    /// |clarity| < 1e-3 mirrors clarity.rs:12). The 40-pixel radius is
    /// the binding constraint for Deep Zoom's 35-pixel overlap budget
    /// (per docs/superpowers/plans/2026-04-25-deep-zoom-tile-rendering.md
    /// § "Architecture" point 2). Do not change the radius without
    /// re-verifying that overlap.
    ///
    /// Composition: this calls `applySeparableGaussianBlur(to:radius:40)`
    /// then mixes via the shared `sceneUnsharp` kernel. Both branches
    /// silent-fallback to identity if any kernel-load step fails.
    public static func applySceneClarity(
        to input: CIImage,
        clarity: Float
    ) -> CIImage {
        if abs(clarity) < 1e-3 { return input }
        let amount = clarity / 100.0
        let blurred = applySeparableGaussianBlur(to: input, radius: 40)
        return applySceneUnsharp(to: input, blurred: blurred, amount: amount)
    }

    /// Apply scene-linear Rec.2020 texture (unsharp mask at radius 3).
    /// Mirrors `texture::apply` from raw-core/src/stages/texture.rs:10.
    /// `texture` is in [-100, +100]; 0 is identity (short-circuit at
    /// |texture| < 1e-3 mirrors texture.rs:12).
    ///
    /// Composition: this calls `applySeparableGaussianBlur(to:radius:3)`
    /// then mixes via the shared `sceneUnsharp` kernel. The mix kernel
    /// is the same instance used by `applySceneClarity` — the only
    /// difference is the upstream blur's radius (3 vs 40), which lives
    /// in the blur scratch and is invisible to this kernel.
    public static func applySceneTexture(
        to input: CIImage,
        texture: Float
    ) -> CIImage {
        if abs(texture) < 1e-3 { return input }
        let amount = texture / 100.0
        let blurred = applySeparableGaussianBlur(to: input, radius: 3)
        return applySceneUnsharp(to: input, blurred: blurred, amount: amount)
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

    private static func sceneUnsharpKernel() -> CIColorKernel? {
        if let k = _sceneUnsharp { return k }
        _sceneUnsharp = loadKernel(file: "SceneUnsharp",
                                   function: "sceneUnsharp") as? CIColorKernel
        return _sceneUnsharp
    }

    // MARK: Private kernel loaders
    //
    // These kernels are defined in `.metal` source files using CoreImage's
    // `coreimage::` namespace, which Xcode's Metal compiler doesn't recognise
    // — so Package.swift declares the Metal directory with `.copy("Metal")`
    // (verbatim file copy, no build-time compilation). At runtime we load
    // the source text and compile via `CIKernel.kernels(withMetalString:)`,
    // then pluck the named kernel out of the result.

    private static func sceneToneControlsKernel() -> CIColorKernel? {
        if let k = _sceneToneControls { return k }
        _sceneToneControls = loadKernel(file: "SceneToneControls",
                                        function: "sceneToneControls") as? CIColorKernel
        return _sceneToneControls
    }

    private static func sceneVibranceKernel() -> CIColorKernel? {
        if let k = _sceneVibrance { return k }
        _sceneVibrance = loadKernel(file: "SceneVibrance",
                                    function: "sceneVibrance") as? CIColorKernel
        return _sceneVibrance
    }

    private static func whiteBalanceKernel() -> CIColorKernel? {
        if let k = _whiteBalance { return k }
        _whiteBalance = loadKernel(file: "WhiteBalance",
                                   function: "whiteBalance") as? CIColorKernel
        return _whiteBalance
    }

    private static func sceneSaturationKernel() -> CIColorKernel? {
        if let k = _sceneSaturation { return k }
        _sceneSaturation = loadKernel(file: "SceneSaturation",
                                      function: "sceneSaturation") as? CIColorKernel
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
