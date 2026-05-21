// MapleAppDriver.swift — Fluent harness for MapleUITests.
//
// Resolves a fixture path against `MAPLE_UITEST_FIXTURE_ROOT` (env var,
// defaults to `<repo>/test-fixtures/raws/`), launches Maple with
// `MAPLE_UITEST_FIXTURE=<basename>`, and exposes wait/screenshot
// helpers built on top of XCUIElement queries against the
// accessibility identifiers added in Task 2 of the plan.
//
// See .archived-plans/plans/2026-04-25-xcuitest-visual-harness.md.

import XCTest
import AppKit

struct MapleAppDriver {
    let app: XCUIApplication

    /// Launch Maple with the given fixture seeded into a single-asset
    /// library. Calls `XCTSkip` if the fixture is missing — mirrors the
    /// `test_color_pipeline.sh` "no fixtures, skipping" pattern (CLAUDE.md
    /// § Build & test — Apple). The fixture path is resolved against
    /// `MAPLE_UITEST_FIXTURE_ROOT` (env var) → repo `test-fixtures/raws/`
    /// (default) — callers should pass the basename ("test_0017.dng"),
    /// not an absolute path.
    static func launch(fixture: String,
                       file: StaticString = #file,
                       line: UInt = #line) throws -> MapleAppDriver {
        let root = Self.fixtureRoot()
        let fixtureURL = URL(fileURLWithPath: root)
            .appendingPathComponent(fixture)
        guard FileManager.default.fileExists(atPath: fixtureURL.path) else {
            throw XCTSkip("UITest fixture missing: \(fixtureURL.path) " +
                          "— set MAPLE_UITEST_FIXTURE_ROOT or check test-fixtures/raws/.",
                          file: file, line: line)
        }

        let app = XCUIApplication()
        // Pass the basename (not the full path); MapleApp.init combines
        // it with MAPLE_UITEST_FIXTURE_ROOT inside the running process so
        // the same env-var contract works whether the fixture root sits
        // inside or outside the sandboxed app's accessible filesystem.
        app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = fixture
        app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = root
        app.launch()
        return MapleAppDriver(app: app)
    }

    /// Block until the canvas accessibility identifier flips to
    /// `canvas-render-ready` (the refine pass has published a preview AND
    /// `EditSession.isRendering` is false — see Task 2.1 in the plan).
    /// Default 30s timeout — first-pass decode of a 100MP RAW takes
    /// ~250-1000ms cold (CLAUDE.md § Performance invariants), with
    /// generous headroom for CI machines.
    func waitForCanvasReady(timeout: TimeInterval = 30,
                            file: StaticString = #file,
                            line: UInt = #line) {
        let canvas = app.otherElements["canvas-render-ready"]
        let predicate = NSPredicate(format: "exists == 1")
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: canvas)
        let result = XCTWaiter().wait(for: [expectation], timeout: timeout)
        XCTAssertEqual(result, .completed,
                       "canvas-render-ready did not appear within \(timeout)s",
                       file: file, line: line)
    }

    /// Screenshot the canvas element and return the PNG bytes, cropped
    /// to the canvas frame.
    ///
    /// macOS XCUITest's element-relative screenshot historically falls
    /// back to a full-window capture for some SwiftUI views (Spike B
    /// open question per the plan). To make the harness self-healing,
    /// we capture both `element.screenshot()` and the canvas frame and:
    ///
    ///   - if the element snapshot is at most ~110% of the canvas frame
    ///     in either axis, we trust it (tight crop, no recrop needed).
    ///   - otherwise the OS gave us a window-or-larger image; manually
    ///     crop using `XCUIScreen.main.screenshot()` + the canvas frame.
    ///
    /// The chosen path is recorded once via `lastSpikeBOutcome` so a
    /// dedicated Spike B test can read it without re-running the whole
    /// flow.
    func screenshotCanvas() -> Data {
        let canvas = app.otherElements["canvas-render-ready"]
        let frame = canvas.frame
        let elementSnap = canvas.screenshot().image
        let elementSize = elementSnap.size  // points (NSImage), should match captured pixel-extent / scale

        // Heuristic: if the element snapshot is roughly the size of the
        // canvas frame (in points), trust it. The 1.1× cushion absorbs
        // backing-scale rounding and a few-px Retina overshoot.
        let tight =
            elementSize.width  <= frame.width  * 1.1 &&
            elementSize.height <= frame.height * 1.1

        if tight {
            Self.lastSpikeBOutcome = "tight (\(Int(elementSize.width))×\(Int(elementSize.height)) within \(Int(frame.width))×\(Int(frame.height)) frame * 1.1)"
            return canvas.screenshot().pngRepresentation
        }

        // Fallback: capture the full screen, crop to canvas frame.
        Self.lastSpikeBOutcome = "manual-crop (\(Int(elementSize.width))×\(Int(elementSize.height)) >> \(Int(frame.width))×\(Int(frame.height)) frame)"
        let screen = XCUIScreen.main.screenshot().image
        let cropped = Self.crop(screen, to: frame)
        guard let png = cropped.tiffRepresentation
            .flatMap({ NSBitmapImageRep(data: $0) })
            .flatMap({ $0.representation(using: .png, properties: [:]) }) else {
            // Fall back to the (probably-too-big) element snapshot if
            // crop somehow failed; let the diff bear the noise.
            return canvas.screenshot().pngRepresentation
        }
        return png
    }

    /// Spike B verdict, populated by the most recent `screenshotCanvas()`
    /// call. `nil` until the first call. Read from a Spike B test for
    /// recording purposes.
    nonisolated(unsafe) static var lastSpikeBOutcome: String?

    /// Crop an `NSImage` to the given frame in points. Used by
    /// `screenshotCanvas()` when the element-relative screenshot is
    /// larger than the canvas frame (the macOS full-window-capture
    /// fallback path).
    private static func crop(_ image: NSImage, to frame: CGRect) -> NSImage {
        let target = NSSize(width: frame.width, height: frame.height)
        let cropped = NSImage(size: target)
        cropped.lockFocus()
        defer { cropped.unlockFocus() }
        let drawRect = NSRect(origin: .zero, size: target)
        let srcRect = NSRect(origin: frame.origin, size: target)
        image.draw(in: drawRect, from: srcRect, operation: .copy, fraction: 1.0)
        return cropped
    }

    /// Convenience for the empty-stub Task 3.3 test: confirms the canvas
    /// element is present and has the ready identifier. Returns the
    /// `XCUIElement` so callers can inspect frame / take screenshots.
    @discardableResult
    func canvasElement() -> XCUIElement {
        return app.otherElements["canvas-render-ready"]
    }

    // MARK: - Fixture root resolution

    private static func fixtureRoot() -> String {
        if let explicit = ProcessInfo.processInfo.environment["MAPLE_UITEST_FIXTURE_ROOT"],
           !explicit.isEmpty {
            return explicit
        }
        // Best-effort fallback when the env var isn't set: the harness
        // process's CWD is typically the project root. Mirrors the
        // default in MapleApp.defaultFixtureRoot().
        return FileManager.default.currentDirectoryPath + "/test-fixtures/raws"
    }
}
