// AutoProfileAEOffDecodeTests871.swift — #871 (reopened).
//
// Split out of AutoProfileCanvasParityTests.swift to keep both files under the
// 600-line file-size budget (tools/check-file-budget.sh). These are the #871
// regression gates for the Apple Auto AE-Off decode fix; they share the
// helpers (`fixtureDir`, `renderApple`, `loadPNG`, `perBandBias`,
// `resampleNearest`) that live in the original file, so they are declared as an
// extension on the same `AutoProfileCanvasParityTests` class — the test bodies
// are preserved byte-for-byte.

import CoreImage
import RawPipeline
import XCTest
@testable import MapleCore

extension AutoProfileCanvasParityTests {

    // MARK: - (1d) #871 reopened: real-fixture Apple Auto develops AE-Off

    /// COMMITTED, fixture-gated GATE (#871 reopened). The root cause of the
    /// Auto overexposure was that the Apple scene-linear decode developed the
    /// Auto displayed buffer with `auto_exposure: On` (the default), while the
    /// Auto Profile curve is fit against — and the CLI/WASM reference applies
    /// it over — an `auto_exposure: Off` buffer. AE-lift and curve-lift then
    /// STACKED, blowing out Auto highlights (Neutral, with no curve, stayed
    /// correct). The fix forces the decode AE Off when an Auto Profile curve
    /// will fit, plumbed via `profileOverride`.
    ///
    /// This gate locks that in WITHOUT any external reference: it decodes the
    /// SAME RAW twice through the live `decodeSceneLinear` path — once with
    /// `profileOverride: .auto`, once with `.neutral` — and asserts the Auto
    /// pre-cube buffer is MEANINGFULLY DARKER (AE skipped) than the Neutral
    /// one. Before the fix both decodes were byte-identical (profile-blind
    /// decode), so this difference is exactly the regression signal. A
    /// re-introduction of the profile-blind decode collapses the two means
    /// back together and fails here. Skips when the RAW fixture is absent
    /// (CI-without-fixtures pattern).
    func testAutoDecodeDevelopsAEOff871() async throws {
        let rawURL = Self.fixtureDir("test-fixtures/raws").appendingPathComponent("test_0003.CR2")
        guard FileManager.default.fileExists(atPath: rawURL.path) else {
            throw XCTSkip("test_0003.CR2 absent — fixture-gated")
        }
        let pipeline = ImageEditPipeline()
        let asset = AssetRef(url: rawURL)

        func meanLuma(profileOverride: Profile) async throws -> Double {
            guard let ci = await pipeline.decodeSceneLinear(
                asset: asset, quality: .full, xmpPath: nil, profileOverride: profileOverride
            ).map(\.image) else { throw XCTSkip("decodeSceneLinear nil") }
            // Materialise the scene-linear (pre-AgX, Rec.2020) decode to f32
            // and average the green channel — AE is a scalar scene-linear
            // gain, so its presence shows directly as a higher mean here.
            let ctx = CIContext(options: [
                .workingColorSpace: CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!,
                .workingFormat: CIFormat.RGBAf,
            ])
            let extent = ci.extent
            // Downsample to a small fixed grid so the render is cheap and the
            // mean is stable across the (large) sensor buffer.
            let w = 64, h = 64
            var px = [Float](repeating: 0, count: w * h * 4)
            px.withUnsafeMutableBytes { buf in
                ctx.render(
                    ci.transformed(by: CGAffineTransform(
                        scaleX: CGFloat(w) / extent.width, y: CGFloat(h) / extent.height)),
                    toBitmap: buf.baseAddress!, rowBytes: w * 16,
                    bounds: CGRect(x: 0, y: 0, width: w, height: h),
                    format: .RGBAf,
                    colorSpace: CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
                )
            }
            var sum = 0.0
            for i in 0..<(w * h) { sum += Double(px[i * 4 + 1]) }  // green lane
            return sum / Double(w * h)
        }

        let autoMean = try await meanLuma(profileOverride: .auto)
        let neutralMean = try await meanLuma(profileOverride: .neutral)
        print(String(format: "[871-ae-off] scene-linear mean G — auto(AE-off)=%.5f neutral(AE-on)=%.5f ratio=%.3f",
                     autoMean, neutralMean, autoMean / max(neutralMean, 1e-6)))
        // AE on test_0003 lifts mid-gray to the 0.18 anchor — a substantial
        // scalar gain. The Auto (AE-off) buffer must therefore be clearly
        // darker than the Neutral (AE-on) buffer. A profile-blind decode (the
        // bug) makes these equal. Require a ≥5% gap as the regression tripwire
        // (observed ratio on test_0003 is well below 0.9).
        XCTAssertLessThan(
            autoMean, neutralMean * 0.95,
            "Auto decode must develop auto_exposure OFF (darker pre-cube than Neutral). "
            + "auto=\(autoMean) neutral=\(neutralMean) — equal means the profile-blind "
            + "decode regressed and the Auto cube will blow out (#871)."
        )
    }

    /// Opt-in (MAPLE_AUTO_E2E=1) end-to-end check against committed CLI
    /// references when present. Renders test_0003 through the LIVE Apple
    /// canvas tail (decodeSceneLinear → processSceneLinear(profileLUT) →
    /// createCGImage) for BOTH Auto and Neutral and gates per-luma-band
    /// per-channel bias vs the `maple-cli --profile auto/neutral` references.
    /// The #871 acceptance: Auto's bias must collapse to within a small
    /// margin of Neutral's bias (the shared AgX-vs-ACR view-transform floor) —
    /// i.e. the Auto-specific blowout is gone. References live at
    /// ~/Desktop/maple-color-tests/871/test_0003_{auto,neutral}_full.png
    /// (regenerate via `maple-cli render … --profile auto/neutral`).
    func testAutoE2EBiasVsCLI_0003() async throws {
        guard ProcessInfo.processInfo.environment["MAPLE_AUTO_E2E"] == "1" else {
            throw XCTSkip("opt-in — set MAPLE_AUTO_E2E=1")
        }
        let rawURL = Self.fixtureDir("test-fixtures/raws").appendingPathComponent("test_0003.CR2")
        guard FileManager.default.fileExists(atPath: rawURL.path) else {
            throw XCTSkip("test_0003.CR2 absent")
        }
        let cliDir = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Desktop/maple-color-tests/871")
        let cliAutoURL = cliDir.appendingPathComponent("test_0003_auto_full.png")
        let cliNeutralURL = cliDir.appendingPathComponent("test_0003_neutral_full.png")
        guard let cliAuto = loadPNG(cliAutoURL), let cliNeutral = loadPNG(cliNeutralURL) else {
            throw XCTSkip("CLI references absent/undecodable under \(cliDir.path)")
        }

        var autoBias = [(lo: Double, hi: Double, r: Double, g: Double, b: Double, n: Int)]()
        var neutralBias = autoBias
        for (label, profile, cli) in [
            ("AUTO", Profile.auto, cliAuto), ("NEUTRAL", Profile.neutral, cliNeutral),
        ] {
            let apple = try await renderApple(rawURL: rawURL, profile: profile)
            let ref = (cli.width == apple.width && cli.height == apple.height)
                ? cli
                : resampleNearest(cli, toWidth: apple.width, height: apple.height)
            let bias = perBandBias(cand: apple.pixels, ref: ref.pixels,
                                   width: apple.width, height: apple.height)
            print("[871-e2e \(label)] Apple(\(apple.width)x\(apple.height)) vs CLI(\(cli.width)x\(cli.height))")
            for b in bias {
                print(String(format: "[871-e2e \(label)] %.2f-%.2f R=%+.4f G=%+.4f B=%+.4f n=%d",
                             b.lo, b.hi, b.r, b.g, b.b, b.n))
            }
            if label == "AUTO" { autoBias = bias } else { neutralBias = bias }
        }

        // #871 acceptance: the Auto-specific overexposure is gone. The
        // Auto-vs-CLI per-channel bias must not exceed the Neutral-vs-CLI bias
        // (the shared, profile-independent AgX-vs-ACR floor) by more than a
        // small margin in any band. Pre-fit this margin was blown by +0.3+ in
        // R/G; the fix brings Auto to within ~0.04 of the Neutral floor.
        let margin = 0.08
        for i in 0..<min(autoBias.count, neutralBias.count) {
            let a = autoBias[i], n = neutralBias[i]
            for (ch, av, nv) in [("R", a.r, n.r), ("G", a.g, n.g), ("B", a.b, n.b)] {
                XCTAssertLessThanOrEqual(
                    abs(av) - abs(nv), margin,
                    "[band \(a.lo)-\(a.hi) \(ch)] Auto bias \(av) exceeds Neutral floor \(nv) "
                    + "by > \(margin) — the #871 Auto overexposure regressed."
                )
            }
        }
    }
}
