// MetalKernels.swift — the surviving Apple-side accessors for the bundled
// AgX LUT binary.
//
// This file used to host Maple's hand-written Metal render kernels. It no
// longer does: #1043 (epic #925 P5b) deleted the last four — `SceneNRColor`,
// `SharpenLumaUSM`, `SharpenEdgeMix` and `SeparableGaussianBlur`, plus their
// `applySceneSharpen` / `applySceneNRColor` / blur wrappers — once the
// wgpu + WGSL chain became the shipping GPU path on every target. Sharpen
// and chroma noise reduction now run inside the render chain itself: on the
// GPU through `raw-gpu`'s `SharpenPass` / `NlmColorPass`, and on the CPU
// fallback through `raw_core::pipeline::apply_scene_linear_chain_f32`, both
// at the canonical scene-linear position (`vignette` → `sharpen` →
// `nr_luminance` → `nr_color`) rather than the post-AgX display-linear
// position the Metal kernels used. The nine cheap scene-linear kernels had
// already been retired earlier, when the Rust FFI gained
// `apply_scene_linear_chain`.
//
// What remains is NOT a render path. `agx_lut.bin` is a cross-platform
// parity ORACLE: `testAppleBundledAgxLUTMatchesRustLUT` in
// `SceneLinearPipelineTests+AgX` asserts the Apple-bundled LUT byte-matches
// the LUT raw-core derives, so the two sides of `derive_agx_lut.py` can
// never drift unnoticed. The accessors below exist to serve that test (and
// any future consumer of the bundled LUT); nothing in the live render path
// calls them.

import CoreImage
import Foundation

// MARK: - MetalKernels (namespace)

public enum MetalKernels {

    // MARK: AgX LUT
    //
    // Both LUTs are emitted by `src/scripts/derive_agx_lut.py` — pass
    // `--apple-bin` to that script to keep the Apple-bundled mirror in sync
    // with the Rust raw-core source of truth.

    /// Build a 1×512 CIImage from the embedded agx_lut.bin (f32 LE).
    /// This is the same binary the Rust pipeline uses (AGX_VERSION 7).
    public static func agxLUTImage() -> CIImage? {
        guard let url = Bundle.module.url(forResource: "agx_lut", withExtension: "bin"),
              let data = try? Data(contentsOf: url) else {
            return agxLUTFallback()
        }
        return agxLUTImage(from: data)
    }

    /// Raw bytes of the embedded agx_lut.bin (f32 LE, 512 entries = 2048 bytes).
    /// Exposed so tests outside the `MapleCore` module can load the same
    /// LUT binary the Rust path uses; `Bundle.module` in a test target
    /// points at the test bundle, not at MapleCore's resource bundle.
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
        // Build as a 1-component float image for sampling.
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
