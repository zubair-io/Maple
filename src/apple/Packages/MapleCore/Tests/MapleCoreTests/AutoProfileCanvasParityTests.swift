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

    // `internal` (not `private`): the #924 residual tests live in an extension
    // in AutoProfileResidualParityTests924.swift and read `Self.lutSize`.
    static let lutSize = 33                        // DEFAULT_LUT_SIZE
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

    // MARK: - (1b) Negative cache is retained (no re-fit on a fit miss) (#844)

    /// A `Profile::Auto` image whose fit FAILS (here: a nonexistent RAW path,
    /// so the FFI returns a read error → `.absent`) must cache that negative
    /// result. A second `filter()` on the same key must be a cache HIT — the
    /// (slow) FFI fit + bake must NOT re-run every render. `fitCount` is the
    /// seam: it counts only cold builds, so a retained negative cache keeps it
    /// at 1 across two lookups.
    func testNegativeCacheIsRetainedNoRefit() async throws {
        let lut = AutoProfileLUT()
        // A path that does not exist → the FFI fit fails → `.absent` is cached.
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("maple-no-such-raw-\(UUID().uuidString).dng")
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))

        let first = await lut.filter(forRawAt: url, profile: .auto, quality: .preview)
        XCTAssertNil(first, "a failed fit must yield no cube (plain AgX)")
        let fitsAfterFirst = await lut.fitCount
        XCTAssertEqual(fitsAfterFirst, 1, "first lookup runs the cold fit exactly once")

        let second = await lut.filter(forRawAt: url, profile: .auto, quality: .preview)
        XCTAssertNil(second, "still no cube")
        let fitsAfterSecond = await lut.fitCount
        XCTAssertEqual(fitsAfterSecond, 1,
            "second lookup must be a NEGATIVE-cache HIT — no re-fit (#844)")
    }

    // MARK: - (2) Opt-in RAW diagnostic (prints numbers, asserts Auto≠Neutral)

    private static func repoRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    static func fixtureDir(_ rel: String) -> URL {
        let primary = repoRoot().appendingPathComponent(rel)
        if FileManager.default.fileExists(atPath: primary.path) { return primary }
        return repoRoot().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent(rel)
    }

    func renderApple(rawURL: URL, profile: Profile)
        async throws -> (pixels: [UInt8], width: Int, height: Int) {
        let pipeline = ImageEditPipeline()
        let asset = AssetRef(url: rawURL)
        // #871: pass the LIVE profile as the decode override so the
        // scene-linear decode develops auto_exposure Off for Auto (matching
        // the buffer the Auto curve was fit against) and On for Neutral —
        // exactly what the live `sharedDecode` does. Without this the FFI
        // falls back to the default model (profile=Auto), forcing AE-Off for
        // BOTH renders and darkening the Neutral candidate.
        guard let decodeResult = await pipeline.decodeSceneLinear(
            asset: asset, quality: .full, xmpPath: nil, profileOverride: profile
        ) else { throw XCTSkip("decodeSceneLinear nil for \(rawURL.lastPathComponent)") }
        let decoded = decodeResult.image

        let asShot: ImageEditPipeline.AsShotWB? = {
            guard let raw = ImageMetadataReader.readAsShotWB(from: rawURL) else { return nil }
            return ImageEditPipeline.AsShotWB(temperature: raw.temperature, tint: raw.tint)
        }()
        var model = AdjustmentModel.default
        model.profile = profile
        // Render at "As Shot": set the WB sliders to the as-shot values so the
        // asShot-relative WB chain (`wb_gains(live)/wb_gains(asShot)`) applies a
        // ZERO shift — the app's default view, and the only WB that matches a CPU
        // `maple_render_file` render (whose default temperature=6500 on the
        // post-DCP D65 buffer is itself a zero shift). Without this the default
        // 6500 drives a spurious `wb_gains(6500)/wb_gains(asShot)` shift that
        // diverges from the CPU reference and dominates any per-band parity bias.
        if let asShot {
            model.temperature = asShot.temperature
            model.tint = asShot.tint
        }
        let profileLUT = await AutoProfileLUT.shared.filter(
            forRawAt: rawURL, profile: profile, quality: .full
        )
        if profile == .auto {
            XCTAssertNotNil(profileLUT, "expected an Auto Profile cube for \(rawURL.lastPathComponent)")
        }
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

    func loadPNG(_ url: URL) -> (pixels: [UInt8], width: Int, height: Int)? {
        guard let data = try? Data(contentsOf: url),
              let src = CGImageSourceCreateWithData(data as CFData, nil),
              let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
        return cgToPixels(cg)
    }

    func perBandBias(cand: [UInt8], ref: [UInt8], width: Int, height: Int)
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

    func resampleNearest(_ img: (pixels: [UInt8], width: Int, height: Int),
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

    // MARK: - (1c) Gamut-correct encode gate vs raw-core (#877 / #871)
    //
    // COMMITTED GATE, fixture-free, <1s. The #877 fix routes the Apple
    // canvas's Rec.2020→sRGB display encode through raw-core's EXACT
    // `rec2020_to_srgb` (hue-preserving Oklab gamut compression, #438) +
    // `srgb_gamma_encode` via `maple_encode_display_srgb_f32`, then tags the
    // result `sRGB` so CoreImage does NO further per-channel clamp. Before
    // #877 the Apple Neutral canvas reached sRGB implicitly at the
    // `createCGImage` boundary, which per-channel-clamps the Rec.2020→sRGB
    // matrix output — driving saturated wide-gamut greens (Rec.2020 ≫ sRGB)
    // green-up / blue-to-zero and diverging from the CLI/CPU reference (the
    // class `_MG_3620`'s grass macro fell into; the #844 Auto cube amplified
    // it into a visible blowout).
    //
    // This test pushes known display-linear Rec.2020 probes — saturated
    // greens (the wide-gamut class) plus a neutral and a near-white — through
    // the EXACT Apple canvas tail the live pipeline now uses (encode FFI →
    // tag sRGB → optional Auto cube → `createCGImage`), and gates each
    // channel's signed bias vs the canonical raw-core encoded u8. Reference
    // u8 are produced by `cargo run -p raw-core --example green-probe`
    // (committed at raw-core/examples/green-probe.rs) so they cannot silently
    // drift. Both `Profile::Neutral` (no cube) and `Profile::Auto` (a
    // synthetic brightening cube — the #844 amplifier) are gated.

    /// One gamut probe: display-linear Rec.2020 input + the canonical
    /// raw-core encoded u8 (Oklab-compressed). Reference from green-probe.rs.
    private struct GamutProbe {
        let name: String
        let displayLinearRec2020: [Float]   // RGB, [0,1]
        let rawCoreU8: [Int]                // raw-core Oklab-compressed encoded u8
        let isWideGamut: Bool               // out-of-sRGB-gamut (blue must stay > 0)
    }

    /// Output raster mode for the gamut probe.
    private enum ProbeOutput {
        /// sRGB raster — the reference space (`maple-cli` emits sRGB). The
        /// main #877 gate uses this to compare apples-to-apples with raw-core.
        case srgb
        /// P3 raster — the live `CIImageView` canvas output space.
        case p3
        /// P3 raster fed through `materializeRegion`'s sRGB CGImage round-trip
        /// first — the refine path. Used only to prove live ≡ refine.
        case p3ViaMaterializeRegion
    }

    /// Render a single display-linear-Rec.2020 RGB value through the live
    /// Apple canvas tail AS REBUILT BY #877: tag a 1×1 `extendedLinearITUR_2020`
    /// f32 CIImage, run the gamut-correct encode FFI
    /// (`maple_encode_display_srgb_f32`), tag the result `sRGB`, optionally
    /// apply the Auto cube, then raster per `output`.
    private func renderThroughGamutCorrectBoundary(
        _ rgb: [Float], cube: CIFilter?, output: ProbeOutput = .srgb
    ) throws -> [Int] {
        // 1. Encode via the FFI (Oklab gamut compression + sRGB gamma) — the
        //    same call `ImageEditPipeline.encodeDisplaySRGBViaFFI` makes.
        var inF32: [Float] = [rgb[0], rgb[1], rgb[2], 1.0]
        let inData = inF32.withUnsafeBytes { Data($0) }
        let encoded = try PipelineRenderer.encodeDisplaySRGB(
            inputBytes: inData, width: 1, height: 1
        )
        // 2. Wrap the sRGB-encoded sRGB-primary bytes tagged sRGB.
        let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
        let inImage = encoded.withUnsafeBytes { raw -> CIImage in
            CIImage(bitmapData: Data(raw), bytesPerRow: 16,
                    size: CGSize(width: 1, height: 1),
                    format: .RGBAf, colorSpace: srgb)
        }
        // 3. Optional Auto cube (sRGB-tagged) — applies on the matching domain.
        var processed = AutoProfileLUT.apply(cube, to: inImage)

        let working = CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!
        let ctx = CIContext(options: [.workingColorSpace: working,
                                      .workingFormat: CIFormat.RGBAh])

        // Refine path: round-trip through an sRGB RGBAf CGImage exactly like
        // `ImageEditPipeline.materializeRegion` (which #877 retags to sRGB).
        if output == .p3ViaMaterializeRegion {
            guard let cg = ctx.createCGImage(
                processed, from: processed.extent, format: .RGBAf, colorSpace: srgb
            ) else { throw XCTSkip("materializeRegion round-trip createCGImage failed") }
            processed = CIImage(cgImage: cg)
        }

        // 4. Raster + read back u8. sRGB is the #877 gate space (= the
        //    maple-cli reference); P3 is the live canvas output space.
        let out: CGColorSpace = (output == .srgb)
            ? srgb
            : CGColorSpace(name: CGColorSpace.displayP3)!
        var outPix = [UInt8](repeating: 0, count: 4)
        outPix.withUnsafeMutableBytes { buf in
            ctx.render(processed, toBitmap: buf.baseAddress!, rowBytes: 4,
                       bounds: CGRect(x: 0, y: 0, width: 1, height: 1),
                       format: .RGBA8, colorSpace: out)
        }
        return [Int(outPix[0]), Int(outPix[1]), Int(outPix[2])]
    }

    /// A synthetic brightening Auto curve (raises every channel) baked into
    /// the cube — stands in for a real per-image fit as the #844 amplifier.
    private func brighteningCurveFlat() -> [Float] {
        var flat = [Float]()
        flat.reserveCapacity(Self.curveFlatLen)
        for _ in 0..<3 {           // all three channels: out = in^0.7 (lift)
            for i in 0..<32 {
                let inp = Float(i) / 31.0
                flat.append(inp)
                flat.append(pow(inp, 0.7))
            }
        }
        flat.append(contentsOf: [1, 0, 0, 0, 1, 0, 0, 0, 1])  // identity matrix
        flat.append(1.0)                                       // chroma_boost
        flat.append(contentsOf: [0, 0])                        // chroma_offset
        flat.append(0.0)                                       // lightness_offset
        flat.append(contentsOf: [0, 0, 0, 0, 0])               // lightness_band
        flat.append(contentsOf: [Float](repeating: 0, count: 10))
        precondition(flat.count == Self.curveFlatLen)
        return flat
    }

    func testGamutCorrectEncodeMatchesRawCore877() throws {
        // raw-core reference u8 (Oklab-compressed) from green-probe.rs — the
        // exact #877 evidence table.
        let probes: [GamutProbe] = [
            GamutProbe(name: "sat-green-0.5", displayLinearRec2020: [0.0, 0.5, 0.0], rawCoreU8: [20, 174, 93], isWideGamut: true),
            GamutProbe(name: "sat-green-0.8", displayLinearRec2020: [0.0, 0.8, 0.0], rawCoreU8: [27, 214, 116], isWideGamut: true),
            GamutProbe(name: "sat-green-1.0", displayLinearRec2020: [0.0, 1.0, 0.0], rawCoreU8: [31, 236, 129], isWideGamut: true),
            GamutProbe(name: "near-white", displayLinearRec2020: [0.95, 0.97, 0.9], rawCoreU8: [248, 252, 242], isWideGamut: false),
            GamutProbe(name: "neutral-mid", displayLinearRec2020: [0.46, 0.46, 0.46], rawCoreU8: [181, 181, 181], isWideGamut: false),
        ]

        // Per-channel bias budget. Rendered to sRGB (the reference space),
        // the Apple boundary now shares raw-core's EXACT encode math, so the
        // only residual is raw-core's Bayer dither vs CoreImage's nearest
        // quantize — observed to be 0 LSB on every probe. ±1 LSB is the tight
        // ceiling; it still catches the old per-channel clamp by a wide margin
        // (which was +24 on green, -91 on blue for sat-green-0.5). One-way
        // ratchet — lower only alongside an improvement.
        let wideBudget = 1
        let neutralBudget = 1
        // Auto = baked 33³ LUT + trilinear vs raw-core's direct curve apply —
        // a few-LSB interpolation gap is expected. ±4 LSB ceiling.
        let autoBudget = 4

        let bright = AutoProfileLUT.buildFilterFromCurve(brighteningCurveFlat())
        XCTAssertNotNil(bright, "brightening cube must build")

        print("[877-gamut] probe | raw-core u8 (Oklab ref) | Apple-Neutral u8 (signed bias) | Apple-Auto u8")
        for p in probes {
            let neutral = try renderThroughGamutCorrectBoundary(p.displayLinearRec2020, cube: nil)
            let auto = try renderThroughGamutCorrectBoundary(p.displayLinearRec2020, cube: bright)
            let bias = (0..<3).map { neutral[$0] - p.rawCoreU8[$0] }
            print(String(format: "[877-gamut] %-13s ref=[%3d %3d %3d] | neutral=[%3d %3d %3d] bias=[%+d %+d %+d] | auto=[%3d %3d %3d]",
                         (p.name as NSString).utf8String!,
                         p.rawCoreU8[0], p.rawCoreU8[1], p.rawCoreU8[2],
                         neutral[0], neutral[1], neutral[2],
                         bias[0], bias[1], bias[2],
                         auto[0], auto[1], auto[2]))

            let budget = p.isWideGamut ? wideBudget : neutralBudget
            for c in 0..<3 {
                XCTAssertLessThanOrEqual(
                    abs(bias[c]), budget,
                    "[\(p.name)] Apple Neutral channel \(c) bias \(bias[c]) exceeds ±\(budget) vs raw-core ref \(p.rawCoreU8) (got \(neutral))"
                )
            }

            // Apple **Auto** vs the raw-core curve reference (#877 acceptance).
            // The synthetic cube applies `out = in^0.7` per channel in
            // sRGB-encoded space (`brighteningCurveFlat`). raw-core's Auto
            // applies the curve directly (`auto_profile::apply_curve`) on the
            // SAME byte-exact encoded input (= rawCoreU8/255), so the reference
            // is `round(255 * (rawCoreU8/255)^0.7)`. The Apple candidate is the
            // baked 33³ LUT + trilinear interpolation, so a few-LSB gap from
            // the direct curve is expected and budgeted (±\(autoBudget)) — this
            // is exactly why the ticket specifies a budget for Auto, not
            // byte-equality.
            let refAuto = p.rawCoreU8.map { v -> Int in
                Int((255.0 * pow(Double(v) / 255.0, 0.7)).rounded())
            }
            let autoBiasArr = (0..<3).map { auto[$0] - refAuto[$0] }
            for c in 0..<3 {
                XCTAssertLessThanOrEqual(
                    abs(autoBiasArr[c]), autoBudget,
                    "[\(p.name)] Apple Auto channel \(c) bias \(autoBiasArr[c]) exceeds ±\(autoBudget) vs raw-core curve ref \(refAuto) (got \(auto))"
                )
            }
            print(String(format: "[877-gamut]   ↳ auto-ref=[%3d %3d %3d] auto-bias=[%+d %+d %+d]",
                         refAuto[0], refAuto[1], refAuto[2],
                         autoBiasArr[0], autoBiasArr[1], autoBiasArr[2]))
            // The crux of #877: on wide-gamut green the OLD per-channel clamp
            // crushed blue to 0. The Oklab compression keeps a real blue
            // component — assert it survives (the clip-vs-compress signal).
            if p.isWideGamut {
                XCTAssertGreaterThan(
                    neutral[2], 30,
                    "[\(p.name)] blue crushed to \(neutral[2]) — wide-gamut green still per-channel-clipped (the #877 bug). Oklab compression should keep blue ≈ \(p.rawCoreU8[2])."
                )
            }
        }

        // Live (CIImageView → P3) vs refine (`materializeRegion` → sRGB
        // CGImage → CIImage → P3) must display the SAME color. Both paths now
        // originate from the same sRGB-tagged encode output; the refine path's
        // extra sRGB→sRGB RGBAf round-trip through a CGImage is lossless for
        // in-gamut content. Lock it with a saturated-green probe through both
        // P3 rasters (the actual canvas output space).
        let g: [Float] = [0.0, 0.8, 0.0]
        let live = try renderThroughGamutCorrectBoundary(g, cube: nil, output: .p3)
        let refine = try renderThroughGamutCorrectBoundary(g, cube: nil, output: .p3ViaMaterializeRegion)
        for c in 0..<3 {
            XCTAssertLessThanOrEqual(
                abs(live[c] - refine[c]), 1,
                "live (P3) vs refine (sRGB-CGImage→P3) diverge on sat-green channel \(c): live=\(live) refine=\(refine)"
            )
        }
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
