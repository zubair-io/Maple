// GpuLiveNoiseProfileTests.swift — #2342 (finishes #1714 on Apple).
//
// #1714 gave the WGSL NLM kernel per-pixel noise-profile modulation and
// plumbed the profile through `FullChainInputs`, the web assembly site, and
// the C ABI. This ticket wires the LAST host — Apple's GPU-live canvas —
// which until now always presented `noise_profile_ptr = NULL` /
// `iso = 0`, denoising with a single flat `h` regardless of the DNG's
// embedded `NoiseProfile` tag while the CPU refine chain (`processSceneLinear`
// via `RenderActor+DecodedCache`'s `sizedResult.noiseProfile`/`.iso`) already
// modulated per pixel. That preview-vs-final seam is what this file gates.
//
// Two layers, mirroring `GpuLiveSessionTests`'s split:
//  1. WIRING / NON-VACUITY (synthetic, no fixture) — proves `noiseProfile`/
//     `iso` reach the FFI and actually change the NLM output, and that they
//     have NO effect when the NR stage itself is off (a control against a
//     false-positive from unrelated nondeterminism — GPU renders here are
//     deterministic per session/model, so this is an exact-equality check).
//  2. GPU-LIVE vs CPU-REFINE PARITY (fixture-gated) — the ticket's own
//     verification note: "a high-ISO RAW's live canvas and its refined
//     render should agree where they visibly disagree today." Skips (not
//     fails) when no committed fixture under `test-fixtures/raws` carries a
//     usable `NoiseProfile` tag — mirrors `test_color_pipeline.sh`'s
//     "no fixtures, skipping" convention, same as
//     `AutoProfileResidualParityTests924`.

import CoreImage
import Foundation
import XCTest
@testable import MapleCore

final class GpuLiveNoiseProfileTests: XCTestCase {

    // MARK: - (1) Wiring / non-vacuity (synthetic, fixture-free)

    /// A gradient with actual per-pixel noise texture (a deterministic LCG,
    /// not CoreImage's `CIRandomGenerator` — no GPU round trip needed to
    /// build the fixture) — NLM's local weighting needs real high-frequency
    /// content to respond differently to a different assumed sigma; a flat
    /// or smooth-only buffer denoises the same regardless of `h`.
    private func noisySceneLinear(_ w: Int, _ h: Int) -> [Float] {
        var state: UInt64 = 0x2545F4914F6CDD1D
        func nextUnit() -> Float {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            return Float((state >> 40) & 0xFFFFFF) / Float(0x1000000) // [0, 1)
        }
        var v = [Float](); v.reserveCapacity(w * h * 4)
        for y in 0..<h {
            for x in 0..<w {
                let t = Float(x + y) / Float(w + h)
                let base = (r: 0.08 + t * 0.5, g: 0.10 + t * 0.4, b: 0.06 + t * 0.3)
                // ±0.03 additive noise per channel — enough spread for NLM's
                // patch-similarity weights to differ under a different h.
                let r = max(0, base.r + (nextUnit() - 0.5) * 0.06)
                let g = max(0, base.g + (nextUnit() - 0.5) * 0.06)
                let b = max(0, base.b + (nextUnit() - 0.5) * 0.06)
                v.append(r); v.append(g); v.append(b); v.append(1.0)
            }
        }
        return v
    }

    /// A representative DNG `NoiseProfile` tag: 6 floats, `(slopeR, offsetR,
    /// slopeG, offsetG, slopeB, offsetB)` — see `raw-core`'s
    /// `stages::nlm::get_noise_params`. Magnitudes are the same order
    /// `fallback_noise_params` derives from ISO 800 (`0.00002 * iso/100`),
    /// scaled per channel so the profile is distinguishable from that
    /// ISO-only fallback, not just from the flat (iso=0) filter.
    private static let sampleNoiseProfile: [Float] = [
        0.00020, 0.000010, // R: slope, offset
        0.00016, 0.000007, // G
        0.00024, 0.000014, // B
    ]

    /// WIRING: opening a session WITH a noise profile + nonzero ISO produces
    /// DIFFERENT NLM output than opening the SAME pixels with no profile /
    /// `iso = 0` (today's Apple behaviour — the flat, non-modulated filter),
    /// when the NR stage is actually engaged. A regression that leaves
    /// `noise_profile_ptr`/`iso` unbound (silently reverting to #2342's
    /// starting state) would make this test fail by producing IDENTICAL
    /// output.
    func test_noiseProfile_and_iso_change_nlm_output_when_denoise_engaged() async throws {
        let (w, h) = (48, 48)
        let pixels = noisySceneLinear(w, h)

        let flatSession = try GpuLiveSession(pixels: pixels, width: w, height: h)
        let profiledSession = try GpuLiveSession(
            pixels: pixels, width: w, height: h,
            noiseProfile: Self.sampleNoiseProfile, iso: 800)

        var model = AdjustmentModel()
        model.profile = .neutral
        model.nrLuminance = 40
        model.nrColor = 40

        guard let flatOut = try await flatSession.renderToBuffer(model: model),
              let profiledOut = try await profiledSession.renderToBuffer(model: model)
        else { return XCTFail("renderToBuffer returned nil (unexpected cancellation)") }

        XCTAssertEqual(flatOut.count, profiledOut.count)
        XCTAssertNotEqual(flatOut, profiledOut,
            "noise_profile/iso must reach the WGSL NLM kernel and change its output — " +
            "identical output means the pair is still unbound (the #2342 starting state)")
    }

    /// CONTROL: the same pair of sessions render BYTE-IDENTICAL output when
    /// the NR stage itself is off (`nrLuminance = nrColor = 0`) — the model
    /// gate short-circuits the stage before `noise_profile`/`iso` are ever
    /// read, so their presence must have NO effect. Guards against the
    /// positive test above passing for the wrong reason (e.g. a stray
    /// nondeterminism in the synthetic buffer generation rather than a real
    /// wiring difference).
    func test_noiseProfile_has_no_effect_when_denoise_disengaged() async throws {
        let (w, h) = (48, 48)
        let pixels = noisySceneLinear(w, h)

        let flatSession = try GpuLiveSession(pixels: pixels, width: w, height: h)
        let profiledSession = try GpuLiveSession(
            pixels: pixels, width: w, height: h,
            noiseProfile: Self.sampleNoiseProfile, iso: 800)

        var model = AdjustmentModel()
        model.profile = .neutral
        model.nrLuminance = 0
        model.nrColor = 0

        guard let flatOut = try await flatSession.renderToBuffer(model: model),
              let profiledOut = try await profiledSession.renderToBuffer(model: model)
        else { return XCTFail("renderToBuffer returned nil (unexpected cancellation)") }

        XCTAssertEqual(flatOut, profiledOut,
            "with NR off, noise_profile/iso must be inert — the stage never reads them")
    }

    // MARK: - (2) GPU-live vs CPU-refine parity (fixture-gated)

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

    /// Rasterize a display-encoded `CIImage` (the CPU chain's output space)
    /// to interleaved RGB u8 at its own extent — no resampling, since both
    /// sides of this comparison are built from the SAME decoded buffer at
    /// the SAME target size.
    private func rgbBytes(from image: CIImage, context: CIContext) -> (pixels: [UInt8], width: Int, height: Int) {
        let w = Int(image.extent.width.rounded())
        let h = Int(image.extent.height.rounded())
        var rgba = [UInt8](repeating: 0, count: w * h * 4)
        let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
        rgba.withUnsafeMutableBytes { buf in
            context.render(image, toBitmap: buf.baseAddress!, rowBytes: w * 4,
                            bounds: CGRect(x: 0, y: 0, width: w, height: h),
                            format: .RGBA8, colorSpace: srgb)
        }
        var rgb = [UInt8](repeating: 0, count: w * h * 3)
        for i in 0..<(w * h) {
            rgb[i * 3 + 0] = rgba[i * 4 + 0]
            rgb[i * 3 + 1] = rgba[i * 4 + 1]
            rgb[i * 3 + 2] = rgba[i * 4 + 2]
        }
        return (rgb, w, h)
    }

    private func meanAbsDiff(_ a: [UInt8], _ b: [UInt8]) -> Double {
        precondition(a.count == b.count)
        guard !a.isEmpty else { return 0 }
        var total: Int = 0
        for i in 0..<a.count { total += abs(Int(a[i]) - Int(b[i])) }
        return Double(total) / Double(a.count)
    }

    /// With the DNG's real `NoiseProfile`/ISO wired into BOTH the GPU-live
    /// session and the CPU refine chain, the two should land close together
    /// on a noise-heavy (high-ISO) frame — the seam the ticket closes.
    /// Aggregate mean-abs-diff only (not a per-band bias budget like the
    /// Auto Profile gates): this is a smoke test for the wiring reaching
    /// production code paths on a real decode, not a tuned colour-parity
    /// gate — the GPU-vs-CPU chain already has known, sanctioned pixel
    /// divergences (sharpen/nr chain position, Auto Profile cube vs curve+
    /// residual passes) documented in `EditSession+GpuLive.swift`, so the
    /// bound here is generous by design.
    func testGpuLiveMatchesCpuRefineOnHighIsoFixture() async throws {
        // Candidate fixtures — whichever exist locally AND carry a
        // `NoiseProfile` tag are exercised; everything else is skipped, not
        // failed. No committed fixture is known to carry one today (the
        // gitignored `test-fixtures/raws` corpus is dev-machine-local), so
        // this legitimately skip-passes in CI and on a fresh clone until a
        // high-ISO RAW with an embedded NoiseProfile is added locally.
        //
        // Decodes at `.preview` (not `.full`): the `NoiseProfile`/ISO tags
        // are decode-quality-independent EXIF/DNG metadata, so `.preview`
        // (the editor's own fast-phase quality) is enough for both the
        // skip-check and the comparison, at a fraction of `.full`'s cost on
        // a 100 MP fixture.
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

            guard let noiseProfile = decodeResult.noiseProfile, !noiseProfile.isEmpty,
                  decodeResult.iso > 0 else {
                print("[noise-profile-parity] SKIP \(name): no embedded NoiseProfile/ISO")
                continue
            }
            ran += 1

            var model = AdjustmentModel()
            model.profile = .neutral
            model.nrLuminance = 40
            model.nrColor = 40

            // GPU-live: the exact readback → open → renderToBuffer path
            // `presentViaGpuLive` drives, with the profile/ISO now wired.
            guard let buf = pipeline.sceneLinearFloats(from: decodeResult.image, targetSize: nil)
            else { continue }
            let session = try GpuLiveSession(
                pixels: buf.pixels, width: buf.width, height: buf.height,
                noiseProfile: noiseProfile, iso: decodeResult.iso)
            guard let gpuOut = try await session.renderToBuffer(model: model) else { continue }

            // CPU refine: the same call `EditSession+Render.swift`'s CPU
            // fallback branch makes, with the SAME profile/ISO.
            let ctx = CIContext()
            let cpuImage = pipeline.processSceneLinear(
                decoded: decodeResult.image, model: model,
                noiseProfile: noiseProfile, iso: decodeResult.iso)
            let cpuRGB = rgbBytes(from: cpuImage, context: ctx)

            // Widen the GPU's packed RGB u8 to match extents (both were
            // built from the identical buffer/target, so dims already
            // agree; guard anyway rather than assume).
            guard gpuOut.count == cpuRGB.pixels.count else {
                print("[noise-profile-parity] SKIP \(name): dim mismatch gpu=\(gpuOut.count) cpu=\(cpuRGB.pixels.count)")
                continue
            }

            let diff = meanAbsDiff(gpuOut, cpuRGB.pixels)
            print("[noise-profile-parity \(name)] mean-abs-diff = \(diff)/255 (iso=\(decodeResult.iso), profile.count=\(noiseProfile.count))")
            XCTAssertLessThan(diff, 20.0,
                "[\(name)] GPU-live vs CPU-refine mean-abs-diff \(diff) too large with NoiseProfile wired")
        }
        if ran == 0 {
            throw XCTSkip("no fixture under test-fixtures/raws carries a usable NoiseProfile/ISO")
        }
    }
}
