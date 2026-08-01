// SidecarSeamUITests.swift — sidecar-staged band/seam gate (#1805 gap 1).
//
// WHY THIS EXISTS. The colour band of #1780 / #1781 / #1801 shipped three
// times while every gate stayed green, and the reason is that the seam
// detectors added in #1772 / #1769 all open their fixture at DEFAULT slider
// values. At defaults the GPU-live per-tick chain and the CPU refine chain
// agree trivially — there is no white-balance delta between them to get
// wrong, no stale anchor to disagree about — so a divergence that only
// appears once a Maple-authored sidecar carries a far-off-D65 temperature
// is invisible to them. The user-facing report was exactly that scenario:
// an image the user had white-balanced in Maple, re-opened, showing a hard
// horizontal band across the canvas.
//
// This gate reproduces that scenario end to end: it stages the real
// `test_0002.dng` together with the committed Maple-authored sidecar in
// `Fixtures/sidecar/test_0002-maple-wb.xmp` (Temperature 8475.5 / Tint 11.11
// at `papp:WbScaleVersion="5"`, i.e. the current Robertson-native scale,
// plus the tone and detail values the report carried), waits for the canvas
// to SETTLE after the refine pass, and applies the row-luminance band metric
// across the canvas.
//
// GPU-LIVE STAYS AT ITS DEFAULT (ON). Every other macOS matrix harness in
// this target pins `MAPLE_GPU_LIVE=0`, because they diff against CPU-rendered
// references. Doing that here would delete the gate: the live-vs-refine
// boundary this test exists to guard only exists on the GPU-live path.
//
// Skips when `test-fixtures/raws/test_0002.dng` is absent (the RAW is
// gitignored), mirroring the repo's harness convention.
//
//   xcodebuild test \
//     -project src/apple/Maple.xcodeproj \
//     -scheme "Maple Exposure" \
//     -destination 'platform=macOS' \
//     -only-testing:MapleUITests/SidecarSeamUITests \
//     MAPLE_UITEST_FIXTURE_ROOT="$PWD/test-fixtures/raws"

import XCTest

#if os(macOS)
import AppKit

final class SidecarSeamUITests: XCTestCase {

    /// A clean render measures a fraction of a level of row-mean second
    /// difference; the reported band steps the row statistic by tens. The
    /// same 5/255 threshold the iPad present-path gate uses — wide margin
    /// on both sides, and robust to the view transform, the decode quality,
    /// and dither noise, none of which can create a step edge in ROW MEANS.
    private static let bandThreshold = 5.0

    /// Non-vacuity floor: a blank or single-tone canvas would pass the band
    /// check trivially. `test_0002` spans a wide luminance range.
    private static let minimumLumaSpread = 20.0

    /// The macOS editor canvas element carries no floating chrome (the
    /// inspector and filmstrip are siblings in the pane shell, not overlays),
    /// so ONE strip spanning the canvas is the right analysis window — "the
    /// band metric across the full canvas" the ticket asks for. The 2% inset
    /// keeps the element's own antialiased border out of the column set; the
    /// row-direction border is handled by `SeamDetector`'s band trim.
    private static let analysisStrips: [ClosedRange<Double>] = [0.02...0.98]

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// Walk `#filePath` up to the repo root. The UITest runner's cwd is its
    /// own sandbox container; the compile-time path survives that.
    private static func repoRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // MapleUITests/
            .deletingLastPathComponent()  // apple/
            .deletingLastPathComponent()  // src/
            .deletingLastPathComponent()  // repo root
    }

    private static func rawsDir() -> URL {
        if let env = ProcessInfo.processInfo.environment["MAPLE_UITEST_FIXTURE_ROOT"],
           !env.isEmpty {
            return URL(fileURLWithPath: env)
        }
        return repoRoot().appendingPathComponent("test-fixtures/raws")
    }

    /// The committed Maple-authored sidecar for the reported scenario.
    private static func sidecarFixture() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/sidecar/test_0002-maple-wb.xmp")
    }

    // MARK: - The gate

    func testSidecarWhiteBalancedOpenHasNoBand() throws {
        let rawURL = Self.rawsDir().appendingPathComponent("test_0002.dng")
        guard FileManager.default.fileExists(atPath: rawURL.path) else {
            throw XCTSkip("UITest fixture missing: \(rawURL.path) " +
                          "— set MAPLE_UITEST_FIXTURE_ROOT or check test-fixtures/raws/.")
        }
        let sidecarURL = Self.sidecarFixture()
        guard FileManager.default.fileExists(atPath: sidecarURL.path) else {
            XCTFail("committed sidecar fixture missing: \(sidecarURL.path)")
            return
        }

        let staged = try StagedFixture.stage(raw: rawURL, sidecar: sidecarURL,
                                             label: "sidecar-seam")
        defer { staged.remove() }

        let png = try Self.captureSettledCanvas(of: staged)
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = "test_0002-maple-wb-canvas.png"
        attachment.lifetime = .keepAlways
        add(attachment)

        guard let rep = NSBitmapImageRep(data: png), let cg = rep.cgImage else {
            XCTFail("could not decode the canvas capture into a CGImage")
            return
        }
        guard let metrics = SeamDetector.metrics(of: cg, strips: Self.analysisStrips) else {
            XCTFail("SeamDetector found no usable image band in the \(cg.width)x\(cg.height) capture")
            return
        }

        print("SIDECAR-SEAM-METRIC maxRowSecondDiff=\(metrics.maxRowSecondDiff)/255 " +
              "worstRow=\(metrics.worstRow)/\(metrics.rowCount) spread=\(metrics.lumaSpread)")

        XCTAssertGreaterThan(
            metrics.lumaSpread, Self.minimumLumaSpread,
            "canvas luminance spread \(metrics.lumaSpread) too narrow — the canvas looks "
            + "blank, so the band check would be vacuous"
        )
        XCTAssertLessThan(
            metrics.maxRowSecondDiff, Self.bandThreshold,
            "row-luminance second difference \(metrics.maxRowSecondDiff)/255 at row "
            + "\(metrics.worstRow)/\(metrics.rowCount) exceeds \(Self.bandThreshold) — a "
            + "horizontal band on a sidecar-white-balanced open, the #1780/#1781/#1801 signature"
        )
    }

    // MARK: - Capture

    /// Launch Maple on `staged`, wait for the canvas sentinel to settle after
    /// the refine pass, and return a PNG of the canvas.
    ///
    /// Settling (`CanvasCapture`, #2277) is load-bearing for a band gate
    /// specifically: it means the capture is the QUIESCED render, so a band
    /// that survives it is a real live-vs-refine disagreement rather than a
    /// mid-flight frame.
    private static func captureSettledCanvas(of staged: StagedFixture) throws -> Data {
        let app = XCUIApplication()
        app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = staged.raw.lastPathComponent
        app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = staged.directory.path
        // NO `MAPLE_GPU_LIVE=0` — see the file header. The GPU-live path is
        // the subject of this gate.
        app.launch()
        defer { app.terminate() }

        let canvas = app.otherElements["canvas-render-ready"]
        guard let frame = CanvasCapture.waitForSettledCanvas(canvas) else {
            throw CaptureError.canvasNeverSettled(CanvasCapture.settleDeadline)
        }
        guard let png = CanvasCapture.canvasPNG(canvas, frame: frame) else {
            throw CaptureError.screenshotUnavailable
        }
        return png
    }

    private enum CaptureError: Error, CustomStringConvertible {
        case canvasNeverSettled(TimeInterval)
        case screenshotUnavailable

        var description: String {
            switch self {
            case .canvasNeverSettled(let seconds):
                return "canvas-render-ready never settled within \(Int(seconds))s"
            case .screenshotUnavailable:
                return "canvas screenshot unavailable (sentinel flipped mid-capture)"
            }
        }
    }
}
#endif // os(macOS)
