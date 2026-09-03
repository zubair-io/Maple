// MaskFixtureUITests.swift — local-adjustment render gate (#355).
//
// Stages `test_0017.dng` with the committed sidecar
// `Fixtures/sidecar/test_0017-masks.xmp` — one linear gradient darkening the
// top of the frame by 2.5 EV and one radial mask lifting + desaturating the
// bottom-center — launches Maple on it, waits for the refine pass, and
// asserts the canvas is NOT the default render: the same CIEDE2000 metric
// the golden gate uses, run against the committed default golden
// (`Goldens/test_0017-default.png`) with the inequality flipped. A pipeline
// that silently dropped the layer stack (a decode that baked nothing, a
// chain that bound a NULL stack, a sidecar reader that lost the containers)
// would reproduce the default golden and fail here.
//
// Runs on the CPU path (`MAPLE_GPU_LIVE=0`, like the golden gate) so the
// capture is byte-comparable to the committed golden; the GPU chain's own
// mask parity is gated in raw-gpu's CPU↔WGSL harness (#1698).
//
//   xcodebuild test \
//     -project src/apple/Maple.xcodeproj \
//     -scheme "Maple Exposure" \
//     -destination 'platform=macOS' \
//     -only-testing:MapleUITests/MaskFixtureUITests \
//     MAPLE_UITEST_FIXTURE_ROOT="$PWD/test-fixtures/raws"

import XCTest

#if os(macOS)
final class MaskFixtureUITests: XCTestCase {
    /// A −2.5 EV gradient over the top third and a +1.5 EV, fully
    /// desaturated ellipse over the bottom-center move the mean ΔE well
    /// past the golden gate's own 5-unit pass budget. Anything below it is
    /// indistinguishable from "masks not applied".
    private static let minimumMeanDeltaE = 5.0

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private static func repoRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private static func rawsDir() -> URL {
        if let env = ProcessInfo.processInfo.environment["MAPLE_UITEST_FIXTURE_ROOT"], !env.isEmpty {
            return URL(fileURLWithPath: env)
        }
        return repoRoot().appendingPathComponent("test-fixtures/raws")
    }

    private static func sidecarFixture() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/sidecar/test_0017-masks.xmp")
    }

    func testMaskedSidecarRendersANonDefaultCanvas() throws {
        let rawURL = Self.rawsDir().appendingPathComponent("test_0017.dng")
        guard FileManager.default.fileExists(atPath: rawURL.path) else {
            throw XCTSkip("UITest fixture missing: \(rawURL.path) " +
                          "— set MAPLE_UITEST_FIXTURE_ROOT or check test-fixtures/raws/.")
        }
        guard let golden = try GoldenStore.loadGolden(name: "test_0017-default") else {
            throw XCTSkip("default golden missing — run MapleUITests.testCanvasMatchesGolden first")
        }
        let sidecarURL = Self.sidecarFixture()
        XCTAssertTrue(FileManager.default.fileExists(atPath: sidecarURL.path),
                      "committed sidecar fixture missing: \(sidecarURL.path)")

        let staged = try StagedFixture.stage(raw: rawURL, sidecar: sidecarURL, label: "mask-fixture")
        defer { staged.remove() }

        let app = XCUIApplication()
        app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = staged.raw.lastPathComponent
        app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = staged.directory.path
        app.launchEnvironment["MAPLE_GPU_LIVE"] = "0"
        app.launch()
        defer { app.terminate() }

        let canvas = app.otherElements["canvas-render-ready"]
        guard let frame = CanvasCapture.waitForSettledCanvas(canvas) else {
            return XCTFail("canvas-render-ready never settled within \(Int(CanvasCapture.settleDeadline))s")
        }
        guard let png = CanvasCapture.canvasPNG(canvas, frame: frame) else {
            return XCTFail("canvas screenshot unavailable")
        }
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = "test_0017-masks-canvas.png"
        attachment.lifetime = .keepAlways
        add(attachment)

        let (candidate, cw, ch) = try GoldenStore.decodeRGBA(png)
        let (reference, rw, rh) = try GoldenStore.decodeRGBA(golden)
        guard cw == rw, ch == rh else {
            return XCTFail("canvas \(cw)x\(ch) vs golden \(rw)x\(rh) — sizes must match to compare")
        }
        guard let metrics = CIEDE2000.compare(
            candidateRGBA: candidate, referenceRGBA: reference, width: cw, height: ch)
        else { return XCTFail("CIEDE2000.compare returned nil") }
        print("MASK-FIXTURE-METRIC mean=\(metrics.meanDeltaE) p95=\(metrics.p95DeltaE) max=\(metrics.maxDeltaE)")
        XCTAssertGreaterThan(
            metrics.meanDeltaE, Self.minimumMeanDeltaE,
            "mean ΔE \(metrics.meanDeltaE) vs the default golden is under \(Self.minimumMeanDeltaE) — " +
            "the sidecar's two masks did not change the render")
    }
}
#endif // os(macOS)
