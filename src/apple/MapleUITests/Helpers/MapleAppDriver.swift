// MapleAppDriver.swift — Fluent harness for MapleUITests.
//
// Resolves a fixture path against `MAPLE_UITEST_FIXTURE_ROOT` (env var,
// defaults to `<repo>/test-fixtures/raws/`), launches Maple with
// `MAPLE_UITEST_FIXTURE=<basename>`, and exposes wait/screenshot
// helpers built on top of XCUIElement queries against the
// accessibility identifiers added in Task 2 of the plan.
//
// See docs/superpowers/plans/2026-04-25-xcuitest-visual-harness.md.

import XCTest

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

    /// Screenshot the canvas element only (cropped to its frame) and
    /// return the PNG bytes. Spike B (2026-04-25) recorded outcome:
    /// see docs/superpowers/plans/2026-04-25-xcuitest-visual-harness.md
    /// for the chosen path (tight crop vs manual `XCUIScreen` + frame).
    func screenshotCanvas() -> Data {
        let canvas = app.otherElements["canvas-render-ready"]
        let snap = canvas.screenshot()
        return snap.pngRepresentation
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
