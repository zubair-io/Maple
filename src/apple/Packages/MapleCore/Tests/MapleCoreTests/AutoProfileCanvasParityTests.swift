// AutoProfileCanvasParityTests.swift — #812.
//
// Two layers of evidence that the Auto Profile cube wires correctly into the
// Apple canvas, neither relying on eyeballing or aggregate ΔE (banned, #530):
//
//   1. `testCubeSamplesLUTFaithfully` (COMMITTED GATE, fixture-free, <1s):
//      the ONLY new Swift code in #812 is `LUT bytes →
//      CIColorCubeWithColorSpace(sRGB) → apply`. This bakes a known
//      non-identity curve into a 33³ LUT via the FFI (the same call the app
//      uses), builds the cube, and feeds it grid-aligned sRGB inputs `k/32`.
//      At grid points trilinear interpolation collapses to the exact LUT
//      entry, so the rendered output MUST equal the LUT — proving CoreImage
//      samples the cube faithfully in the tagged sRGB space. A wrong
//      dimension / channel order / alpha / color-space would diverge here.
//
//   2. `testAutoProfileCanvasDiagnostic` (DIAGNOSTIC, opt-in via
//      MAPLE_AUTOPROFILE_DIAG=1): renders a real RAW through the live canvas
//      with Profile Auto + Neutral and prints the per-luma-band per-channel
//      delta-of-deltas vs `maple-cli render` references. NOT an asserting
//      gate — cross-engine band binning of a steep curve across two encode
//      engines (Rust quantize vs CoreImage color management) leaves an
//      irreducible mid-band residual that is binning, not a cube defect (the
//      committed grid gate is what proves the cube faithful). Kept for
//      triage. The Auto≠Neutral acceptance is asserted here too.

import CoreImage
import RawPipeline
import XCTest
@testable import MapleCore

final class AutoProfileCanvasParityTests: XCTestCase {

    private static let lutSize = 33               // DEFAULT_LUT_SIZE
    private static let curveFlatLen = 220         // PROFILE_CURVE_FLAT_LEN

    // MARK: - (1) Committed gate: cube samples the LUT faithfully

    /// A valid flat `ProfileCurve` with a non-identity per-channel monotone
    /// output and identity matrix / zero corrections (mirrors the
    /// display-space fit, which only carries the per-channel curve). Output
    /// differs per channel so a channel-swap in the cube is caught.
    private func syntheticCurveFlat() -> [Float] {
        var flat = [Float]()
        flat.reserveCapacity(Self.curveFlatLen)
        let gammas: [Float] = [0.80, 1.00, 1.25]  // R brightens, G identity, B darkens
        for g in gammas {
            for i in 0..<32 {
                let inp = Float(i) / 31.0
                flat.append(inp)
                flat.append(pow(inp, g))
            }
        }
        // matrix = identity (row-major 3x3)
        flat.append(contentsOf: [1, 0, 0, 0, 1, 0, 0, 0, 1])
        flat.append(1.0)            // chroma_boost
        flat.append(contentsOf: [0, 0])         // chroma_offset
        flat.append(0.0)            // lightness_offset
        flat.append(contentsOf: [0, 0, 0, 0, 0])    // lightness_band_offsets
        flat.append(contentsOf: [Float](repeating: 0, count: 10))  // ab_band_offsets
        precondition(flat.count == Self.curveFlatLen)
        return flat
    }

    func testCubeSamplesLUTFaithfully() throws {
        let n = Self.lutSize
        let curve = syntheticCurveFlat()

        // Bake the LUT via the FFI — the exact bytes the app's cube is built
        // from.
        var lut = [Float](repeating: 0, count: n * n * n * 3)
        let rc = curve.withUnsafeBufferPointer { c in
            lut.withUnsafeMutableBufferPointer { l in
                maple_compute_profile_lut(c.baseAddress, UInt(c.count), UInt32(n), l.baseAddress)
            }
        }
        XCTAssertEqual(rc, 0, "maple_compute_profile_lut rc=\(rc)")

        // Build the cube exactly as AutoProfileLUT does.
        guard let filter = AutoProfileLUT.buildFilterFromCurve(curve) else {
            return XCTFail("buildFilterFromCurve returned nil")
        }

        // Grid-aligned probe: a row of pixels at sRGB value (k/(n-1)) on all
        // three channels, for k = 0..<n. CIColorCube samples the cube in the
        // tagged sRGB space, so we feed an sRGB-tagged input image and read
        // an sRGB-tagged output — at grid points trilinear = exact entry.
        let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
        var inPix = [UInt8](repeating: 0, count: n * 4)
        for k in 0..<n {
            let v = UInt8((Double(k) / Double(n - 1) * 255.0).rounded())
            inPix[k * 4 + 0] = v
            inPix[k * 4 + 1] = v
            inPix[k * 4 + 2] = v
            inPix[k * 4 + 3] = 255
        }
        let inImage = inPix.withUnsafeMutableBytes { raw -> CIImage in
            let data = Data(raw)
            return CIImage(bitmapData: data, bytesPerRow: n * 4,
                           size: CGSize(width: n, height: 1),
                           format: .RGBA8, colorSpace: srgb)
        }

        let out = AutoProfileLUT.apply(filter, to: inImage)
        let ctx = CIContext(options: [.workingColorSpace: srgb])
        var outPix = [UInt8](repeating: 0, count: n * 4)
        outPix.withUnsafeMutableBytes { buf in
            ctx.render(out, toBitmap: buf.baseAddress!, rowBytes: n * 4,
                       bounds: CGRect(x: 0, y: 0, width: n, height: 1),
                       format: .RGBA8, colorSpace: srgb)
        }

        // The diagonal grid pixel k maps to LUT entry at (r=g=b=k), i.e.
        // index ((k*n + k)*n + k) — and at that entry R/G/B = curve_c(k/(n-1)).
        // Allow ±2/255 for the 8-bit round-trip through CoreImage.
        var maxErr = 0
        for k in 0..<n {
            let idx = ((k * n + k) * n + k) * 3
            let expR = UInt8((Double(lut[idx + 0]) * 255).rounded().clamped(0, 255))
            let expG = UInt8((Double(lut[idx + 1]) * 255).rounded().clamped(0, 255))
            let expB = UInt8((Double(lut[idx + 2]) * 255).rounded().clamped(0, 255))
            let gotR = outPix[k * 4 + 0], gotG = outPix[k * 4 + 1], gotB = outPix[k * 4 + 2]
            maxErr = max(maxErr, abs(Int(gotR) - Int(expR)),
                         abs(Int(gotG) - Int(expG)), abs(Int(gotB) - Int(expB)))
            XCTAssertLessThanOrEqual(abs(Int(gotR) - Int(expR)), 2,
                "R grid k=\(k): got \(gotR) exp \(expR)")
            XCTAssertLessThanOrEqual(abs(Int(gotG) - Int(expG)), 2,
                "G grid k=\(k): got \(gotG) exp \(expG)")
            XCTAssertLessThanOrEqual(abs(Int(gotB) - Int(expB)), 2,
                "B grid k=\(k): got \(gotB) exp \(expB)")
        }
        print("[cube-faithfulness] max 8-bit error at grid points = \(maxErr)/255")
    }

    // MARK: - (2) Opt-in RAW diagnostic (prints numbers, asserts Auto≠Neutral)

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

    private func renderApple(rawURL: URL, profile: Profile)
        async throws -> (pixels: [UInt8], width: Int, height: Int) {
        let pipeline = ImageEditPipeline()
        let asset = AssetRef(url: rawURL)
        guard let decoded = await pipeline.decodeSceneLinear(
            asset: asset, quality: .full, xmpPath: nil
        ) else { throw XCTSkip("decodeSceneLinear nil for \(rawURL.lastPathComponent)") }

        var model = AdjustmentModel.default
        model.profile = profile
        let profileLUT = await AutoProfileLUT.shared.filter(
            forRawAt: rawURL, profile: profile, quality: .full
        )
        if profile == .auto {
            XCTAssertNotNil(profileLUT, "expected an Auto Profile cube for \(rawURL.lastPathComponent)")
        }
        let asShot: ImageEditPipeline.AsShotWB? = {
            guard let raw = ImageMetadataReader.readAsShotWB(from: rawURL) else { return nil }
            return ImageEditPipeline.AsShotWB(temperature: raw.temperature, tint: raw.tint)
        }()
        let processed = pipeline.processSceneLinear(
            decoded: decoded, model: model, targetSize: nil,
            asShot: asShot, decodedAtModel: .default, profileLUT: profileLUT
        )
        let workingSpace = CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!
        let outputSpace = CGColorSpace(name: CGColorSpace.sRGB)!
        let ciContext: CIContext = {
            if let device = MTLCreateSystemDefaultDevice() {
                return CIContext(mtlDevice: device, options: [
                    .workingColorSpace: workingSpace, .workingFormat: CIFormat.RGBAh,
                    .cacheIntermediates: false,
                ])
            }
            return CIContext(options: [
                .workingColorSpace: workingSpace, .workingFormat: CIFormat.RGBAh,
                .cacheIntermediates: false,
            ])
        }()
        let extent = processed.extent
        guard extent.width > 0, extent.height > 0,
              let cg = ciContext.createCGImage(processed, from: extent,
                                               format: .RGBA8, colorSpace: outputSpace)
        else { throw XCTSkip("createCGImage failed for \(rawURL.lastPathComponent)") }
        return cgToPixels(cg)
    }

    private func cgToPixels(_ cg: CGImage) -> (pixels: [UInt8], width: Int, height: Int) {
        let w = cg.width, h = cg.height
        var pixels = [UInt8](repeating: 0, count: w * h * 4)
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = CGContext(data: &pixels, width: w, height: h, bitsPerComponent: 8,
                            bytesPerRow: w * 4, space: cs,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        return (pixels, w, h)
    }

    private func loadPNG(_ url: URL) -> (pixels: [UInt8], width: Int, height: Int)? {
        guard let data = try? Data(contentsOf: url),
              let src = CGImageSourceCreateWithData(data as CFData, nil),
              let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
        return cgToPixels(cg)
    }

    private func perBandBias(cand: [UInt8], ref: [UInt8], width: Int, height: Int)
        -> [(lo: Double, hi: Double, r: Double, g: Double, b: Double, n: Int)] {
        let bands: [(Double, Double)] = [
            (0.00, 0.10), (0.10, 0.25), (0.25, 0.50), (0.50, 0.75), (0.75, 1.001),
        ]
        var sR = [Double](repeating: 0, count: 5), sG = sR, sB = sR
        var cnt = [Int](repeating: 0, count: 5)
        for i in 0..<(width * height) {
            let o = i * 4
            let cr = Double(cand[o]) / 255, cg = Double(cand[o + 1]) / 255, cb = Double(cand[o + 2]) / 255
            let rr = Double(ref[o]) / 255, rg = Double(ref[o + 1]) / 255, rb = Double(ref[o + 2]) / 255
            let luma = 0.2126 * rr + 0.7152 * rg + 0.0722 * rb
            for (bi, band) in bands.enumerated() where luma >= band.0 && luma < band.1 {
                sR[bi] += cr - rr; sG[bi] += cg - rg; sB[bi] += cb - rb; cnt[bi] += 1
                break
            }
        }
        return (0..<5).map { bi in
            let nn = max(cnt[bi], 1)
            return (bands[bi].0, bands[bi].1, sR[bi] / Double(nn), sG[bi] / Double(nn), sB[bi] / Double(nn), cnt[bi])
        }
    }

    private func resampleNearest(_ img: (pixels: [UInt8], width: Int, height: Int),
                                 toWidth tw: Int, height th: Int)
        -> (pixels: [UInt8], width: Int, height: Int) {
        var out = [UInt8](repeating: 0, count: tw * th * 4)
        for y in 0..<th {
            let sy = min(y * img.height / th, img.height - 1)
            for x in 0..<tw {
                let sx = min(x * img.width / tw, img.width - 1)
                let so = (sy * img.width + sx) * 4, dst = (y * tw + x) * 4
                out[dst] = img.pixels[so]; out[dst + 1] = img.pixels[so + 1]
                out[dst + 2] = img.pixels[so + 2]; out[dst + 3] = 255
            }
        }
        return (out, tw, th)
    }

    func testAutoProfileCanvasDiagnostic() async throws {
        guard ProcessInfo.processInfo.environment["MAPLE_AUTOPROFILE_DIAG"] == "1" else {
            throw XCTSkip("opt-in diagnostic — set MAPLE_AUTOPROFILE_DIAG=1")
        }
        let rawURL = Self.fixtureDir("test-fixtures/raws").appendingPathComponent("test_0000.DNG")
        guard FileManager.default.fileExists(atPath: rawURL.path) else {
            throw XCTSkip("test_0000.DNG absent")
        }
        let cliDir = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Desktop/maple-color-tests/812")
        let cliAutoURL = cliDir.appendingPathComponent("test_0000_auto.png")
        let cliNeutralURL = cliDir.appendingPathComponent("test_0000_neutral.png")
        guard FileManager.default.fileExists(atPath: cliAutoURL.path),
              FileManager.default.fileExists(atPath: cliNeutralURL.path) else {
            throw XCTSkip("CLI references absent under \(cliDir.path)")
        }

        let appleAuto = try await renderApple(rawURL: rawURL, profile: .auto)
        let appleNeutral = try await renderApple(rawURL: rawURL, profile: .neutral)

        let appleDelta = perBandBias(cand: appleAuto.pixels, ref: appleNeutral.pixels,
                                     width: appleAuto.width, height: appleAuto.height)
        let maxApple = appleDelta.map { max(abs($0.r), abs($0.g), abs($0.b)) }.max() ?? 0
        for b in appleDelta {
            print(String(format: "[apple auto-neutral] %.2f-%.2f R=%+.4f G=%+.4f B=%+.4f n=%d",
                         b.lo, b.hi, b.r, b.g, b.b, b.n))
        }
        XCTAssertGreaterThan(maxApple, 0.01, "Auto must change the canvas vs Neutral")

        guard let cliAuto = loadPNG(cliAutoURL), let cliNeutral = loadPNG(cliNeutralURL) else {
            throw XCTSkip("CLI ref decode failed")
        }
        let cliDelta = perBandBias(cand: cliAuto.pixels, ref: cliNeutral.pixels,
                                   width: cliAuto.width, height: cliAuto.height)
        for b in cliDelta {
            print(String(format: "[cli   auto-neutral] %.2f-%.2f R=%+.4f G=%+.4f B=%+.4f n=%d",
                         b.lo, b.hi, b.r, b.g, b.b, b.n))
        }
        let nref = (cliNeutral.width == appleNeutral.width && cliNeutral.height == appleNeutral.height)
            ? cliNeutral
            : resampleNearest(cliNeutral, toWidth: appleNeutral.width, height: appleNeutral.height)
        let floor = perBandBias(cand: appleNeutral.pixels, ref: nref.pixels,
                                width: appleNeutral.width, height: appleNeutral.height)
        for b in floor {
            print(String(format: "[neutral floor] %.2f-%.2f R=%+.4f G=%+.4f B=%+.4f n=%d",
                         b.lo, b.hi, b.r, b.g, b.b, b.n))
        }
        for i in 0..<5 {
            print(String(format: "[Δapple-Δcli] %.2f-%.2f R=%+.4f G=%+.4f B=%+.4f",
                         appleDelta[i].lo, appleDelta[i].hi,
                         appleDelta[i].r - cliDelta[i].r,
                         appleDelta[i].g - cliDelta[i].g,
                         appleDelta[i].b - cliDelta[i].b))
        }
    }
}

private extension Double {
    func clamped(_ lo: Double, _ hi: Double) -> Double { Swift.min(Swift.max(self, lo), hi) }
}
