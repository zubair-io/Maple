// SliderRegressionProbeTests.swift — regression net for Bug 2 (Ticket 12).
//
// Bug 2 (filed 2026-04-26): every slider except contrast was a no-op on
// Mac/iPad. Root cause was in MetalKernels.swift — `loadKernel(...) as?
// CIColorKernel` returned nil for every `coreimage::sampler_h`-based
// kernel because `CIKernel.kernels(withMetalString:)` returns those as
// general `CIKernel`, not `CIColorKernel`. The wrapper then silently
// `return input`. Only AgX (which uses `coreimage::sample_t` and is a
// real `CIColorKernel`) actually executed — explaining "only contrast
// works."
//
// `testKernelLoadDiagnostic` documents the observed return classes for
// each kernel — if a future Metal/CoreImage update changes the
// reflection result we'll see it explicitly here.
//
// `testXxxChangesPixel` invokes each scene-linear wrapper end-to-end on
// a synthetic input and asserts the output buffer differs from the
// unadjusted baseline. A regression that re-introduces the no-op (or
// any future wiring break that suppresses the kernel's effect) will
// fail these.

import XCTest
import CoreImage
import CoreGraphics
@testable import MapleCore

final class SliderRegressionProbeTests: XCTestCase {

    /// Probe whether non-AgX scene-linear kernels load at all. With
    /// `coreimage::sampler_h` arguments, modern CoreImage may return a
    /// CIKernel that is NOT a CIColorKernel — the `as? CIColorKernel`
    /// cast in MetalKernels.swift then returns nil and the wrapper
    /// silently identity-passes. AgX uses `coreimage::sample_t` which
    /// IS a CIColorKernel, hence the contrast slider still works.
    func testKernelLoadDiagnostic() {
        let cases: [(String, String)] = [
            ("SceneToneControls",   "sceneToneControls"),
            ("SceneVibrance",       "sceneVibrance"),
            ("SceneSaturation",     "sceneSaturation"),
            ("WhiteBalance",        "whiteBalance"),
            ("AgXViewTransform",    "agxViewTransform"),
        ]
        for (file, function) in cases {
            guard let data = sourceForFile(file),
                  let source = String(data: data, encoding: .utf8) else {
                XCTFail("source for \(file) not found")
                continue
            }
            let kernels: [CIKernel]
            do {
                kernels = try CIKernel.kernels(withMetalString: source)
            } catch {
                XCTFail("\(file) compile failed: \(error)")
                continue
            }
            let match = kernels.first(where: { $0.name == function })
            let className = match.map { String(describing: type(of: $0)) } ?? "nil"
            print("KERNEL_LOAD: \(file).\(function) → \(className)")
        }
    }

    private func sourceForFile(_ name: String) -> Data? {
        let bundle = Bundle.module
        if let url = bundle.url(forResource: name, withExtension: "metal", subdirectory: "Metal") {
            return try? Data(contentsOf: url)
        }
        if let url = bundle.url(forResource: name, withExtension: "metal") {
            return try? Data(contentsOf: url)
        }
        return nil
    }

    /// Sanity check on the Oklab roundtrip: feed a saturated red
    /// (R=0.8, G=0.1, B=0.1) through ONLY the saturation kernel at -100
    /// (full desaturate) and assert the output is near-gray (R≈G≈B
    /// within ±0.1). Catches a future regression in the saturation
    /// kernel's matrix orientation — without the `v * M_metal` form
    /// (Bug 2 follow-up matrix fix), the same input produced (5.4,
    /// -2.0, 0.16), wildly out-of-range nonsense.
    func testSaturationMinus100ProducesNearGray() {
        let input = makeSceneLinearImage(r: 0.8, g: 0.1, b: 0.1)
        let out = MetalKernels.applySceneSaturation(to: input, saturation: -100)
        let rgb = readCenterRGBFP16(out)
        print("SAT-100 PROBE: input (0.8, 0.1, 0.1) → output (\(rgb.r), \(rgb.g), \(rgb.b))")
        // Loose tolerance — the goal is "did the kernel produce gray?",
        // not exact channel parity (matrices may differ slightly from Rust).
        XCTAssertLessThan(abs(rgb.r - rgb.g), 0.1, "saturation -100 should approach gray")
        XCTAssertLessThan(abs(rgb.g - rgb.b), 0.1, "saturation -100 should approach gray")
    }

    private func makeSceneLinearImage(r: Float, g: Float, b: Float) -> CIImage {
        let w = 16, h = 16
        var pixels = [UInt16](repeating: 0, count: w * h * 4)
        let R = float32_to_half(r), G = float32_to_half(g), B = float32_to_half(b)
        let one = float32_to_half(1)
        for i in 0..<(w * h) {
            pixels[i * 4 + 0] = R
            pixels[i * 4 + 1] = G
            pixels[i * 4 + 2] = B
            pixels[i * 4 + 3] = one
        }
        let bpr = w * 8
        let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        return pixels.withUnsafeBufferPointer { buf in
            CIImage(
                bitmapData: Data(buffer: buf),
                bytesPerRow: bpr,
                size: CGSize(width: w, height: h),
                format: .RGBAh,
                colorSpace: space
            )
        }
    }

    private func readCenterRGBFP16(_ ci: CIImage) -> (r: Float, g: Float, b: Float) {
        let device = MTLCreateSystemDefaultDevice()
        let workSpace = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        let ctx: CIContext
        if let d = device {
            ctx = CIContext(mtlDevice: d, options: [
                .workingColorSpace: workSpace,
                .workingFormat: CIFormat.RGBAh,
                .cacheIntermediates: false,
            ])
        } else {
            ctx = CIContext(options: [
                .workingColorSpace: workSpace,
                .workingFormat: CIFormat.RGBAh,
            ])
        }
        guard let cg = ctx.createCGImage(
            ci, from: CGRect(x: 0, y: 0, width: 16, height: 16),
            format: .RGBAh, colorSpace: workSpace
        ), let cfData = cg.dataProvider?.data else {
            return (.nan, .nan, .nan)
        }
        let bytes = UnsafeRawPointer(CFDataGetBytePtr(cfData)!)
        let bpr = cg.bytesPerRow
        let cx = 8, cy = 8
        let off = cy * bpr + cx * 4 * 2
        let r = Self.half_to_float32(bytes.load(fromByteOffset: off + 0, as: UInt16.self))
        let g = Self.half_to_float32(bytes.load(fromByteOffset: off + 2, as: UInt16.self))
        let b = Self.half_to_float32(bytes.load(fromByteOffset: off + 4, as: UInt16.self))
        return (r, g, b)
    }

    private static func half_to_float32(_ h: UInt16) -> Float {
        let sign = UInt32(h >> 15) & 0x1
        let exp = UInt32((h >> 10) & 0x1f)
        let mant = UInt32(h & 0x3ff)
        if exp == 0 {
            if mant == 0 { return sign == 0 ? 0.0 : -0.0 }
            // subnormal — approximate
            let v = Float(mant) / 1024.0 * powf(2, -14)
            return sign == 0 ? v : -v
        } else if exp == 0x1f {
            return sign == 0 ? .infinity : -.infinity
        }
        let bits = (sign << 31) | ((exp + 127 - 15) << 23) | (mant << 13)
        return Float(bitPattern: bits)
    }

    func testToneControlsExposureChangesPixel() {
        let baseline = renderCenterPixel { ci in
            MetalKernels.applySceneToneControls(
                to: ci, exposure: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0
            )
        }
        let bumped = renderCenterPixel { ci in
            MetalKernels.applySceneToneControls(
                to: ci, exposure: 1.0, highlights: 0, shadows: 0, whites: 0, blacks: 0
            )
        }
        print("ToneControls baseline=\(baseline) exposure=+1 → \(bumped)")
        XCTAssertNotEqual(baseline.0, bumped.0,
            "exposure +1 should brighten center pixel; identity passthrough means kernel never ran")
    }

    func testWhiteBalanceTemperatureChangesPixel() {
        let baseline = renderCenterPixel { ci in
            MetalKernels.applyWhiteBalance(
                to: ci,
                liveTemperature: 6500, liveTint: 0,
                decodedTemperature: 6500, decodedTint: 0
            )
        }
        let warmer = renderCenterPixel { ci in
            MetalKernels.applyWhiteBalance(
                to: ci,
                liveTemperature: 8500, liveTint: 0,
                decodedTemperature: 6500, decodedTint: 0
            )
        }
        print("WhiteBalance baseline=\(baseline) live8500 → \(warmer)")
        XCTAssertTrue(
            baseline.0 != warmer.0 || baseline.1 != warmer.1 || baseline.2 != warmer.2,
            "WB +2000K should shift R/B; identity passthrough means kernel never ran")
    }

    func testVibranceChangesPixel() {
        let baseline = renderCenterPixel(rgb: (0.6, 0.4, 0.2)) { ci in
            MetalKernels.applySceneVibrance(to: ci, vibrance: 0)
        }
        let bumped = renderCenterPixel(rgb: (0.6, 0.4, 0.2)) { ci in
            MetalKernels.applySceneVibrance(to: ci, vibrance: 100)
        }
        print("Vibrance baseline=\(baseline) +100 → \(bumped)")
        XCTAssertTrue(
            baseline.0 != bumped.0 || baseline.1 != bumped.1 || baseline.2 != bumped.2,
            "vibrance +100 on a colored pixel should shift channels; identity passthrough means kernel never ran")
    }

    func testSaturationChangesPixel() {
        let baseline = renderCenterPixel(rgb: (0.6, 0.4, 0.2)) { ci in
            MetalKernels.applySceneSaturation(to: ci, saturation: 0)
        }
        let bumped = renderCenterPixel(rgb: (0.6, 0.4, 0.2)) { ci in
            MetalKernels.applySceneSaturation(to: ci, saturation: 100)
        }
        print("Saturation baseline=\(baseline) +100 → \(bumped)")
        XCTAssertTrue(
            baseline.0 != bumped.0 || baseline.1 != bumped.1 || baseline.2 != bumped.2,
            "saturation +100 on colored pixel should shift channels; identity passthrough means kernel never ran")
    }

    // MARK: - Helpers

    private func renderCenterPixel(
        rgb: (Float, Float, Float) = (0.5, 0.5, 0.5),
        _ apply: (CIImage) -> CIImage
    ) -> (UInt8, UInt8, UInt8) {
        let w = 4, h = 4
        var pixels = [UInt16](repeating: 0, count: w * h * 4)
        let r = float32_to_half(rgb.0)
        let g = float32_to_half(rgb.1)
        let b = float32_to_half(rgb.2)
        let aOne = float32_to_half(1.0)
        for i in 0..<(w * h) {
            pixels[i * 4 + 0] = r
            pixels[i * 4 + 1] = g
            pixels[i * 4 + 2] = b
            pixels[i * 4 + 3] = aOne
        }
        let rec2020 = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        let bytesPerRow = w * 8
        let inputCI = pixels.withUnsafeBufferPointer { buf -> CIImage in
            let data = Data(buffer: buf)
            return CIImage(
                bitmapData: data,
                bytesPerRow: bytesPerRow,
                size: CGSize(width: w, height: h),
                format: .RGBAh,
                colorSpace: rec2020
            )
        }
        let out = apply(inputCI)

        // Render via AgX so we land on display-linear and the diff is
        // visible in u8. (Without AgX, scene-linear-as-sRGB is also
        // legible but more sensitive to extended range.)
        let withAgX = MetalKernels.applyAgXViewTransform(to: out, contrast: 0)

        let outSpace = CGColorSpace(name: CGColorSpace.sRGB)!
        let workingSpace = CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!
        let ciCtx: CIContext
        if let device = MTLCreateSystemDefaultDevice() {
            ciCtx = CIContext(mtlDevice: device, options: [
                .workingColorSpace: workingSpace,
                .workingFormat: CIFormat.RGBAh,
                .cacheIntermediates: false,
            ])
        } else {
            ciCtx = CIContext(options: [
                .workingColorSpace: workingSpace,
                .workingFormat: CIFormat.RGBAh,
                .cacheIntermediates: false,
            ])
        }
        guard let cg = ciCtx.createCGImage(
            withAgX,
            from: CGRect(x: 0, y: 0, width: w, height: h),
            format: .RGBA8,
            colorSpace: outSpace
        ) else {
            XCTFail("createCGImage returned nil")
            return (0, 0, 0)
        }
        return readCenterPixelU8(cg)
    }

    private func readCenterPixelU8(_ cg: CGImage) -> (UInt8, UInt8, UInt8) {
        let w = cg.width, h = cg.height
        let bytesPerRow = w * 4
        var buf = [UInt8](repeating: 0, count: w * h * 4)
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = CGContext(
            data: &buf,
            width: w, height: h,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: space,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        let cy = h / 2, cx = w / 2
        let i = (cy * w + cx) * 4
        return (buf[i], buf[i + 1], buf[i + 2])
    }

    private func float32_to_half(_ f: Float) -> UInt16 {
        let bits = f.bitPattern
        let sign = UInt16((bits >> 31) & 0x1) << 15
        let exp = Int((bits >> 23) & 0xff) - 127 + 15
        let mant = (bits >> 13) & 0x3ff
        if exp <= 0 {
            return sign
        } else if exp >= 0x1f {
            return sign | (0x1f << 10)
        }
        return sign | (UInt16(exp) << 10) | UInt16(mant)
    }
}
