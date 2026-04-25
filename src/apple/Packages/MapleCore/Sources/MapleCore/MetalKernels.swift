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

// MARK: - MetalKernels (namespace)

public enum MetalKernels {
    // Kernels are compiled lazily on first access.
    private static var _sceneToneControls: CIColorKernel?
    private static var _sceneVibrance: CIColorKernel?
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

    // MARK: AgXViewTransform

    public static func applyAgXViewTransform(
        to input: CIImage,
        contrast: Float
    ) -> CIImage {
        guard let kernel = agxKernel() else { return input }
        guard let lut = agxLUTImage() else { return input }

        return kernel.apply(
            extent: input.extent,
            roiCallback: { _, rect in rect },
            arguments: [input, lut, contrast]
        ) ?? input
    }

    // MARK: Private kernel loaders

    private static func sceneToneControlsKernel() -> CIColorKernel? {
        if let k = _sceneToneControls { return k }
        guard let src = metalSource("SceneToneControls") else { return nil }
        _sceneToneControls = try? CIColorKernel(functionName: "sceneToneControls",
                                                fromMetalLibraryData: src)
        return _sceneToneControls
    }

    private static func sceneVibranceKernel() -> CIColorKernel? {
        if let k = _sceneVibrance { return k }
        guard let src = metalSource("SceneVibrance") else { return nil }
        _sceneVibrance = try? CIColorKernel(functionName: "sceneVibrance",
                                             fromMetalLibraryData: src)
        return _sceneVibrance
    }

    private static func agxKernel() -> CIKernel? {
        if let k = _agxViewTransform { return k }
        guard let src = metalSource("AgXViewTransform") else { return nil }
        _agxViewTransform = try? CIKernel(functionName: "agxViewTransform",
                                           fromMetalLibraryData: src)
        return _agxViewTransform
    }

    // MARK: Helpers

    /// Load compiled Metal library data for a kernel by name.
    /// The bundle resource name is the kernel's Metal file base name + ".metallib"
    /// (compiled by Xcode / SwiftPM at build time).
    private static func metalSource(_ name: String) -> Data? {
        // When built with Xcode/SwiftPM, Metal sources are compiled into a
        // .metallib and embedded in the bundle as "default.metallib".
        // We load the shared default metallib for all kernels.
        let bundle = Bundle.module
        if let url = bundle.url(forResource: "default", withExtension: "metallib") {
            return try? Data(contentsOf: url)
        }
        // Fallback: look for a per-kernel metallib (unusual but possible).
        if let url = bundle.url(forResource: name, withExtension: "metallib") {
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
