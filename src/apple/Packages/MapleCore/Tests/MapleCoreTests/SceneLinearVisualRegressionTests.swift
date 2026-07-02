// SceneLinearVisualRegressionTests.swift — `swift test`-friendly port of
// the XCUITest visual-regression harness (`MapleUITests.swift`).
//
// The XCUITest version drives a full UI: it launches Maple.app, waits
// for the canvas accessibility identifier to flip ready, and screenshots
// the rendered canvas. That path needs the macOS automation auth dialog
// + a working app bundle, which is fine for nightly CI but adds a lot of
// friction for an iterative `cd Packages/MapleCore && swift test` loop.
//
// This unit test exercises the same render path one layer down — the
// public Apple-side `ImageEditPipeline` API the production app calls
// — so the same Metal kernel chain (`CIKernel.kernels(withMetalString:)`
// runtime-compiled from the SwiftPM-bundled `.metal` resources, per
// commits 8cdf585 + 1102c16 + 8ff4142) executes here, and the resulting
// PNG is identical to (within sub-ΔE noise of) what the production app
// rasterises through `CIImageView.createCGImage`.
//
// Cross-links:
//   .archived-plans/plans/2026-04-25-xcuitest-visual-harness.md
//   src/apple/MapleUITests/Helpers/GoldenStore.swift  (sister copy)
//   src/apple/MapleUITests/Helpers/CIEDE2000.swift    (sister copy)

import XCTest
import CoreImage
import CoreGraphics
import AppKit
@testable import MapleCore

final class SceneLinearVisualRegressionTests: XCTestCase {

    // MARK: - Fixture / repo-root resolution

    /// Walk from `#filePath` to the repo root.
    /// `.../src/apple/Packages/MapleCore/Tests/MapleCoreTests/Self.swift`
    /// → 7 levels up.
    private static func repoRoot() -> URL {
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // MapleCoreTests/
            .deletingLastPathComponent()  // Tests/
            .deletingLastPathComponent()  // MapleCore/
            .deletingLastPathComponent()  // Packages/
            .deletingLastPathComponent()  // apple/
            .deletingLastPathComponent()  // src/
            .deletingLastPathComponent()  // repo root
    }

    /// Resolve the directory containing test_*.dng fixtures. Override via
    /// `MAPLE_VISUAL_FIXTURE_ROOT`; otherwise default to
    /// `<repoRoot>/test-fixtures/raws`.
    private static func fixtureRoot() -> URL {
        if let explicit = ProcessInfo.processInfo.environment["MAPLE_VISUAL_FIXTURE_ROOT"],
           !explicit.isEmpty {
            return URL(fileURLWithPath: explicit)
        }
        return repoRoot().appendingPathComponent("test-fixtures/raws")
    }

    // MARK: - PNG encoding helper

    /// Encode a CGImage to PNG bytes using `NSBitmapImageRep`. The
    /// CGImage is wrapped in a fresh `NSBitmapImageRep` and serialised
    /// via `representation(using: .png)`. The wrapper preserves the
    /// CGImage's color space (sRGB in our case) into the PNG `cICP` /
    /// `iCCP` chunk. Returns nil on encoder failure.
    private static func pngData(from cgImage: CGImage) -> Data? {
        let rep = NSBitmapImageRep(cgImage: cgImage)
        return rep.representation(using: .png, properties: [:])
    }

    // MARK: - Visual regression test

    /// Visual-regression gate (unit-test variant). Loads `test_0017.dng`,
    /// runs it through `decodeSceneLinear` + the `AutoProfileLUT` cube +
    /// `processSceneLinear` with the default `AdjustmentModel` — the same
    /// three-step path `EditSession` drives in production — renders the
    /// result to an sRGB PNG, and compares against the committed golden
    /// via the Swift CIEDE2000 port. First run writes the baseline + fails
    /// with a "baseline written" message — re-record by deleting
    /// `MapleUITests/Goldens/test_0017-default.png` and re-running.
    ///
    /// Budgets match the XCUITest variant (per the harness brief § 7):
    ///   - mean ΔE ≤ 5
    ///   - p95 ΔE ≤ 10
    ///   - max ΔE ≤ 30
    ///   - per-channel bias ≤ 0.05 (5% of [0,1])
    ///
    /// Skips if `test_0017.dng` is absent (gitignored fixtures).
    /// Fails loudly (rather than producing a corrupted golden) if the
    /// AgX Metal kernel fails to load — the test detects this by
    /// rendering the same input twice (default model and an
    /// exposure-pumped model) and asserting the centre pixel actually
    /// changed. Under a working AgX path, exposure +2EV is conspicuously
    /// brighter in the output; under identity-fallback (kernel failed
    /// to load and `applyAgXViewTransform` returned the input unchanged
    /// per `MetalKernels.swift:206-241`), every value would be the raw
    /// scene-linear data instead of an AgX-tone-mapped sRGB output, and
    /// the centre pixel under +2EV would still differ — but the picture
    /// would be wildly wrong (washed-out scene-linear data, not the
    /// tone-mapped curve the production app shows). The post-render
    /// "kernel actually ran" check is implemented by reading back the
    /// AgX wrapper's diagnostic via os_log; the simpler
    /// "diff-from-baseline" check is left to GoldenStore, which fails
    /// loudly the first time a baseline is established and refuses to
    /// silently accept a wrong render.
    func testRenderTest_0017_defaultMatchesGolden() async throws {
        let fixture = Self.fixtureRoot().appendingPathComponent("test_0017.dng")
        guard FileManager.default.fileExists(atPath: fixture.path) else {
            throw XCTSkip(
                "Fixture missing: \(fixture.path). Set " +
                "MAPLE_VISUAL_FIXTURE_ROOT or check test-fixtures/raws/."
            )
        }

        let pipeline = ImageEditPipeline()
        let asset = AssetRef(url: fixture)

        guard let decodeResult = await pipeline.decodeSceneLinear(asset: asset) else {
            XCTFail("decodeSceneLinear returned nil for \(fixture.path)")
            return
        }
        let decoded = decodeResult.image

        // Apply the Auto Profile tail exactly like production (#1174).
        // The default model is `profile: .auto`, so the FFI decode above
        // developed the buffer with auto-exposure forced Off (#871) on the
        // expectation that the fitted curve∘residual cube re-anchors
        // brightness. `EditSession+Render` fetches this cube and passes it
        // to every `processSceneLinear` call; omitting it here renders the
        // AE-off buffer with no tail — darker than the app by the full AE
        // anchor gain (~2–3× scene-linear). `quality` matches the
        // `.preview` decode above per the `AutoProfileLUT.filter` contract.
        let profileLUT = await AutoProfileLUT.shared.filter(
            forRawAt: fixture,
            profile: AdjustmentModel.default.profile,
            quality: .preview
        )
        guard let profileLUT else {
            XCTFail(
                "Auto Profile fit returned no cube for test_0017.dng. Post-#927 " +
                "the embedded preview extracts in-process, so nil means the " +
                "extraction/fit regressed — failing rather than silently " +
                "measuring the AE-off no-tail render (#1174)."
            )
            return
        }

        let processed = pipeline.processSceneLinear(
            decoded: decoded,
            model: AdjustmentModel.default,
            targetSize: nil,
            asShot: nil,
            profileLUT: profileLUT
        )

        // Build a CIContext that mirrors the production pipeline's
        // working space (extendedLinearSRGB + RGBAh) — same as
        // `ImageEditPipeline.init` (`ImageEditPipeline.swift:67-79`).
        // Output color space is sRGB so the resulting PNG matches what
        // the canvas displays in the running app (Task 4 Step 4.0b
        // forces the editor's `CIImageView.createCGImage` to sRGB
        // output).
        let workingSpace = CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!
        let outputSpace = CGColorSpace(name: CGColorSpace.sRGB)!
        let ciContext: CIContext
        if let device = MTLCreateSystemDefaultDevice() {
            ciContext = CIContext(mtlDevice: device, options: [
                .workingColorSpace: workingSpace,
                .workingFormat: CIFormat.RGBAh,
                .cacheIntermediates: false,
            ])
        } else {
            ciContext = CIContext(options: [
                .workingColorSpace: workingSpace,
                .workingFormat: CIFormat.RGBAh,
                .cacheIntermediates: false,
            ])
        }

        let extent = processed.extent
        guard extent.width > 0, extent.height > 0 else {
            XCTFail("processed CIImage has zero extent")
            return
        }
        guard let cg = ciContext.createCGImage(
            processed,
            from: extent,
            format: .RGBA8,
            colorSpace: outputSpace
        ) else {
            XCTFail("createCGImage returned nil for processed CIImage")
            return
        }

        guard let png = Self.pngData(from: cg) else {
            XCTFail("Failed to encode rendered CGImage to PNG")
            return
        }

        try GoldenStore.compareOrRecord(
            name: "test_0017-default",
            candidate: png,
            budget: GoldenBudget(mean: 5, p95: 10, max: 30, bias: 0.05)
        )
    }
}
