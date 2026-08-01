// IpadPresentSeamUITests.swift — iPad-simulator partial-render (splice) gate
// for the GPU-live present path (#1769).
//
// The iPad TestFlight reports (#1737 → #1742/#1743 → #1769) show a hard
// single-scanline horizontal seam on the editor canvas after a cold open with
// layout churn: the top of the canvas holds the current frame while the region
// below holds an EARLIER pipeline state — a splice of two frames inside one
// CAMetalLayer drawable. The mechanism is drawable-pool invalidation outside
// wgpu's `just_configured` settle window (host `drawableSize` writes, the
// fast→refine session re-open, layer-pointer ABA) — see the #1769 audit.
//
// This test drives exactly those triggers on an iPad simulator and asserts a
// SEAM DETECTOR on the canvas screenshot rather than a golden diff: the max
// per-row second difference of row-mean luminance. A clean render of
// test_0002 measures ≈0.6–1.1/255 (ordinary scene content); a spliced frame
// pair measures tens of levels (the cold-open frame states diverge by mean
// ~45/255 since the Jul-2026 colorimetry arc). Threshold 5 gives a wide
// margin on both sides and is robust to the AgX-vs-Auto look, the exact
// decode quality, and run-to-run dither noise — none of which can create a
// step edge in ROW MEANS.
//
// iOS-only: the macOS present path is covered by the raw-gpu offscreen parity
// gates (`present_chain/tests.rs`, incl. the #1743 row-alignment gate) and the
// macOS golden harness. Runs on an installed iPad simulator:
//
//   xcodebuild test \
//     -project src/apple/Maple.xcodeproj \
//     -scheme "Maple Exposure" \
//     -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M4)' \
//     -only-testing:MapleUITests/IpadPresentSeamUITests \
//     MAPLE_UITEST_FIXTURE_ROOT="$PWD/test-fixtures/raws"
//
// XCTSkips without the fixture (CI without test-fixtures/raws/test_0002.dng),
// mirroring the repo's harness convention.

import XCTest

#if os(iOS)
import UIKit

final class IpadPresentSeamUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// Walk #filePath up to the repo root (the UITest runner's cwd is its
    /// sandbox container; the compile-time path survives that). Mirrors
    /// `LaunchScreenshotUITests.repoRoot()`.
    private static func repoRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // MapleUITests/
            .deletingLastPathComponent()  // apple/
            .deletingLastPathComponent()  // src/
            .deletingLastPathComponent()  // repo root
    }

    private static func fixtureRoot() -> String {
        if let explicit = ProcessInfo.processInfo.environment["MAPLE_UITEST_FIXTURE_ROOT"],
           !explicit.isEmpty {
            return explicit
        }
        return Self.repoRoot().appendingPathComponent("test-fixtures/raws").path
    }

    /// THE #1769 GATE: cold-open `test_0002` on the GPU-live canvas while
    /// driving the exact layout-churn triggers of the splice (rotation during
    /// AND after the cold open — every rotation frame fires `layoutSubviews`
    /// across the pane shell, the historical `drawableSize`-write path), then
    /// assert the canvas holds ONE coherent frame via the row-luminance seam
    /// detector.
    func testColdOpenWithLayoutChurnHasNoSpliceSeam() throws {
        let root = Self.fixtureRoot()
        let fixture = "test_0002.dng"
        let fixtureURL = URL(fileURLWithPath: root).appendingPathComponent(fixture)
        guard FileManager.default.fileExists(atPath: fixtureURL.path) else {
            throw XCTSkip("UITest fixture missing: \(fixtureURL.path) " +
                          "— set MAPLE_UITEST_FIXTURE_ROOT or check test-fixtures/raws/.")
        }

        let app = XCUIApplication()
        app.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
        app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = fixture
        app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = root
        // GPU-live stays at its DEFAULT (on) — this is a GPU present-path gate,
        // unlike the golden harness (which pins MAPLE_GPU_LIVE=0 for its CPU
        // goldens).
        //
        // The Photo Library permission alert (PhotoKit source init) otherwise
        // lands ON the canvas and pollutes the screenshot. Pre-grant on the
        // target simulator (`xcrun simctl privacy <udid> grant photos
        // app.justmaple.aperture`) for a deterministic run; this monitor
        // clears it on machines where that hasn't happened — the corner tap
        // after the ready-wait below is its trigger point.
        addUIInterruptionMonitor(withDescription: "photo-library-permission") { alert in
            let allow = alert.buttons["Allow Full Access"]
            if allow.exists {
                allow.tap()
                return true
            }
            let dontAllow = alert.buttons["Don't Allow"]
            if dontAllow.exists {
                dontAllow.tap()
                return true
            }
            return false
        }
        XCUIDevice.shared.orientation = .portrait
        app.launch()

        // Layout churn DURING the cold open: rotate while the decode/present
        // pipeline is racing through its embedded-preview → fast → refine
        // states. Pre-#1769 each rotation's layout pass rewrote
        // `layer.drawableSize`, invalidating the drawable pool under an
        // unsuspecting single present.
        XCUIDevice.shared.orientation = .landscapeLeft
        Thread.sleep(forTimeInterval: 1.0)
        XCUIDevice.shared.orientation = .portrait
        Thread.sleep(forTimeInterval: 1.0)

        // Wait for the first full-quality frame. On iOS the root-level
        // `editor-view` accessibility identifier clobbers descendant
        // identifiers, so the canvas readiness sentinel rides the element's
        // accessibility VALUE (see EditorView.canvasLeafContent, #1769); the
        // element itself is matched by its label.
        let canvas = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == 'Editor canvas'"))
            .firstMatch
        let ready = NSPredicate(format: "exists == 1 AND value == 'canvas-render-ready'")
        let readyWait = XCTWaiter().wait(
            for: [XCTNSPredicateExpectation(predicate: ready, object: canvas)],
            timeout: 120
        )
        if readyWait != .completed {
            // Attach the a11y tree so a ready-identifier regression is
            // diagnosable from the xcresult without a local re-run.
            let dump = XCTAttachment(
                data: Data(app.debugDescription.utf8),
                uniformTypeIdentifier: "public.plain-text"
            )
            dump.name = "a11y-dump-on-timeout"
            dump.lifetime = .keepAlways
            add(dump)
        }
        XCTAssertEqual(readyWait, .completed,
                       "canvas-render-ready did not appear within 120s")

        // Give any pending system alert its trigger point so the interruption
        // monitor can clear it off the canvas before the screenshot. Tapping
        // an inert corner is the documented way to pump the monitor; harmless
        // when no alert is up.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.98)).tap()
        Thread.sleep(forTimeInterval: 1.0)

        // Churn again AFTER the ready flip — the refine re-open (new session
        // dims) and the rotation land back to back, the exact boundary the
        // audit's polarity evidence pinned — then settle.
        XCUIDevice.shared.orientation = .landscapeLeft
        Thread.sleep(forTimeInterval: 1.5)
        XCUIDevice.shared.orientation = .portrait
        Thread.sleep(forTimeInterval: 3.0)

        let shot = canvas.screenshot().image
        let png = canvas.screenshot().pngRepresentation
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = "ipad-canvas-after-churn"
        attachment.lifetime = .keepAlways
        add(attachment)

        guard let cg = shot.cgImage,
              let metrics = SeamDetector.metrics(of: cg, strips: Self.analysisStrips) else {
            XCTFail("could not decode canvas screenshot into RGBA bytes")
            return
        }
        print("SEAM-METRIC maxRowSecondDiff=\(metrics.maxRowSecondDiff)/255 " +
              "worstRow=\(metrics.worstRow)/\(metrics.rowCount) spread=\(metrics.lumaSpread)")
        // Non-vacuous: a black/blank canvas would trivially pass the seam
        // check. test_0002 spans a wide luminance range.
        XCTAssertGreaterThan(
            metrics.lumaSpread, 20.0,
            "canvas luminance spread \(metrics.lumaSpread) too narrow — canvas looks blank, " +
            "the seam check would be vacuous"
        )
        // THE SEAM GATE: clean renders measure ≈0.6–1.1/255; a splice of two
        // cold-open frame states measures tens. Threshold 5/255.
        XCTAssertLessThan(
            metrics.maxRowSecondDiff, 5.0,
            "row-luminance second difference \(metrics.maxRowSecondDiff)/255 at row " +
            "\(metrics.worstRow)/\(metrics.rowCount) exceeds 5 — a horizontal splice seam " +
            "(two pipeline states in one drawable), the #1769 signature"
        )
    }

    // MARK: - Seam-detector geometry

    /// Normalized column strips handed to `SeamDetector`, calibrated
    /// against real iPad captures:
    ///   * the filmstrip (x ≲ 15%) and its collapse handle (~16–18%) sit
    ///     OUTSIDE the left strip's inner edge;
    ///   * the control panel (~52–89%) + dock (~91–98%) float over the
    ///     right strip — which side depends on the interface orientation
    ///     the rotation churn settled in (simulator captures occasionally
    ///     come back 180°-flipped, mirroring all chrome);
    ///   * so in EITHER orientation at least one strip contains no large
    ///     chrome, and the small zoom badge that can enter a strip (~20% of
    ///     its columns) is removed by the trimmed row mean.
    /// A real splice is FULL-WIDTH by construction, so it appears in BOTH
    /// strips at full strength — `SeamDetector` takes the MINIMUM of the
    /// two strips' maxima: chrome pollutes one strip, never both.
    static let analysisStrips: [ClosedRange<Double>] = [0.18...0.35, 0.65...0.82]
}
#endif // os(iOS)
