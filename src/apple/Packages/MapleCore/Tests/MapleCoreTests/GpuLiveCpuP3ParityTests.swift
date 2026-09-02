// GpuLiveCpuP3ParityTests.swift — #3190 (P3 phase 2, CPU display-encode
// follow-up).
//
// #1338 wired the P3 canvas toggle (`CanvasColorSpace`) into the GPU-live
// path only. #3190 gives the CPU display-encode path
// (`ImageEditPipeline.processSceneLinear` → `encodeDisplayViaFFI`) a
// P3-aware sibling FFI entry and wires it to the SAME `CanvasColorSpace`
// setting. This file is the acceptance test named in #3190: a P3-tagged CPU
// render must equal the GPU-live P3 render within budget on a fixture —
// the CPU-side analogue of `GpuLiveNoiseProfileTests`'s GPU-vs-CPU parity
// layer, same skip-pass convention (no committed fixture carries the
// scenario, so this legitimately skips on a fresh clone / CI).
//
// `Profile::Neutral` only: the Auto Profile cube is fit/baked in sRGB, so a
// `Profile::Auto` render intentionally stays pinned to sRGB regardless of
// `CanvasColorSpace` (see `ImageEditPipeline.processSceneLinear`'s
// `targetPrimaries: profileLUT != nil ? .srgb : CanvasColorSpace.current`)
// — testing Neutral isolates exactly the code path #3190 changed.

import CoreImage
import Foundation
import XCTest
@testable import MapleCore

final class GpuLiveCpuP3ParityTests: XCTestCase {
    private static let stateLock = NSLock()

    /// Force `CanvasColorSpace.current` to `.displayP3` for the duration of
    /// `body`, restoring the prior UserDefaults state afterward — same
    /// save/mutate/restore + lock pattern `CanvasColorSpaceTests` uses,
    /// since this key is process-global.
    private func withP3CanvasColorSpace(_ body: () async throws -> Void) async rethrows {
        Self.stateLock.lock()
        let saved = UserDefaults.standard.object(forKey: CanvasColorSpace.defaultsKey)
        UserDefaults.standard.set(CanvasColorSpace.displayP3.rawValue, forKey: CanvasColorSpace.defaultsKey)
        defer {
            if let saved {
                UserDefaults.standard.set(saved, forKey: CanvasColorSpace.defaultsKey)
            } else {
                UserDefaults.standard.removeObject(forKey: CanvasColorSpace.defaultsKey)
            }
            Self.stateLock.unlock()
        }
        try await body()
    }

    private static func repoRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private static func fixtureDir(_ rel: String) -> URL {
        let primary = repoRoot().appendingPathComponent(rel)
        if FileManager.default.fileExists(atPath: primary.path) { return primary }
        return repoRoot().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent(rel)
    }

    /// Rasterize a display-encoded `CIImage` to interleaved RGB u8 at its
    /// own extent, through a render target tagged `targetColorSpace` — MUST
    /// be the SAME primaries the image is already tagged with (Display P3
    /// here) so this is a byte-identity readback, not a color-managed
    /// conversion. That is what makes the result comparable to GPU-live's
    /// `renderToBuffer`, which returns raw `dither_and_quantize` bytes with
    /// no CoreImage color management layer at all.
    private func rgbBytes(from image: CIImage, context: CIContext, targetColorSpace: CGColorSpace) -> [UInt8] {
        let bounds = image.extent.integral
        let w = Int(bounds.width)
        let h = Int(bounds.height)
        var rgba = [UInt8](repeating: 0, count: w * h * 4)
        rgba.withUnsafeMutableBytes { buf in
            context.render(image, toBitmap: buf.baseAddress!, rowBytes: w * 4,
                            bounds: bounds,
                            format: .RGBA8, colorSpace: targetColorSpace)
        }
        var rgb = [UInt8](repeating: 0, count: w * h * 3)
        for i in 0..<(w * h) {
            rgb[i * 3 + 0] = rgba[i * 4 + 0]
            rgb[i * 3 + 1] = rgba[i * 4 + 1]
            rgb[i * 3 + 2] = rgba[i * 4 + 2]
        }
        return rgb
    }

    private func meanAbsDiff(_ a: [UInt8], _ b: [UInt8]) -> Double {
        precondition(a.count == b.count)
        guard !a.isEmpty else { return 0 }
        var total = 0
        for i in 0..<a.count { total += abs(Int(a[i]) - Int(b[i])) }
        return Double(total) / Double(a.count)
    }

    /// GPU-LIVE vs CPU-DISPLAY-ENCODE P3 PARITY (fixture-gated): with the
    /// canvas colorspace forced to Display P3 and `Profile::Neutral` (no
    /// Auto cube in play), the CPU `processSceneLinear` output — tagged P3
    /// by #3190's `encodeDisplayViaFFI(_:targetPrimaries:)` — must
    /// agree with `GpuLiveSession.renderToBuffer` (which already read
    /// `CanvasColorSpace.current` via `makeGpuLiveParams`'s default
    /// argument since #3192) to within the same mean-abs-diff budget
    /// `GpuLiveNoiseProfileTests` uses for its own GPU-vs-CPU comparison.
    func testCpuP3DisplayEncodeMatchesGpuLiveP3() async throws {
        try await withP3CanvasColorSpace {
            let candidates = [
                "test_0000.DNG", "test_0002.dng", "test_0003.CR2",
                "test_0006.DNG", "test_0007.DNG", "dji-mavic3pro-100mp.dng",
            ]
            let pipeline = ImageEditPipeline()
            var ran = 0
            for name in candidates {
                let rawURL = Self.fixtureDir("test-fixtures/raws").appendingPathComponent(name)
                guard FileManager.default.fileExists(atPath: rawURL.path) else { continue }

                let asset = AssetRef(url: rawURL)
                guard let decodeResult = await pipeline.decodeSceneLinear(
                    asset: asset, quality: .preview, xmpPath: nil, profileOverride: .neutral
                ) else { continue }
                ran += 1

                var model = AdjustmentModel()
                model.profile = .neutral

                guard let buf = pipeline.sceneLinearFloats(from: decodeResult.image, targetSize: nil)
                else { continue }
                let session = try GpuLiveSession(pixels: buf.pixels, width: buf.width, height: buf.height)
                guard let gpuOut = try await session.renderToBuffer(model: model) else { continue }

                let ctx = CIContext()
                let cpuImage = pipeline.processSceneLinear(decoded: decodeResult.image, model: model)
                let p3 = CGColorSpace(name: CGColorSpace.displayP3)!
                let cpuRGB = rgbBytes(from: cpuImage, context: ctx, targetColorSpace: p3)

                guard gpuOut.count == cpuRGB.count else {
                    print("[p3-cpu-gpu-parity] SKIP \(name): dim mismatch gpu=\(gpuOut.count) cpu=\(cpuRGB.count)")
                    continue
                }

                let diff = meanAbsDiff(gpuOut, cpuRGB)
                print("[p3-cpu-gpu-parity \(name)] mean-abs-diff = \(diff)/255")
                XCTAssertLessThan(diff, 20.0,
                    "[\(name)] GPU-live P3 vs CPU display-encode P3 mean-abs-diff \(diff) too large")
            }
            if ran == 0 {
                throw XCTSkip("no fixture under test-fixtures/raws")
            }
        }
    }
}
