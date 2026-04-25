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
