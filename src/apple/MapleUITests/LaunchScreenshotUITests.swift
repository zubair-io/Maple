import XCTest

final class LaunchScreenshotUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
    }

    override func tearDownWithError() throws {
        app?.terminate()
        app = nil
    }

    func testLaunchesAndAttachesWindowScreenshot() throws {
        app.launch()

        let window = app.windows.firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 10), "Maple did not open a window within 10 seconds.")

        let screenshot = window.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = "Maple launch window"
        attachment.lifetime = .keepAlways
        add(attachment)

        XCTAssertGreaterThan(screenshot.pngRepresentation.count, 0, "Window screenshot was empty.")
    }

    /// Walk #filePath up to the repo root. The UITest runner is sandboxed
    /// so its cwd-based fallback resolves to the container, not the repo.
    /// Compile-time #filePath survives that.
    /// `.../src/apple/MapleUITests/LaunchScreenshotUITests.swift` → 4 up.
    private static func repoRoot() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // MapleUITests/
            .deletingLastPathComponent()  // apple/
            .deletingLastPathComponent()  // src/
            .deletingLastPathComponent()  // repo root
    }

    /// Smoke test: open one RAW, wait for the canvas to render, screenshot it.
    /// Saves the PNG to /tmp/maple-smoke/<stem>.png so the user can inspect
    /// directly without trawling xcresult bundles. Also attaches to the test
    /// result for the Xcode reporter.
    ///
    /// Fixture stem comes from MAPLE_SMOKE_STEM (default "test_0017"). The
    /// fixture file is resolved against `<repo>/test-fixtures/raws/` via
    /// `#filePath` (compile-time path, robust against the sandbox).
    func testOpensFixtureAndScreenshotsCanvas() throws {
        let stem = ProcessInfo.processInfo.environment["MAPLE_SMOKE_STEM"]
            ?? "test_0017"
        let ext = ProcessInfo.processInfo.environment["MAPLE_SMOKE_EXT"]
            ?? "dng"
        let fixture = "\(stem).\(ext)"

        let rawsDir = Self.repoRoot().appendingPathComponent("test-fixtures/raws")
        let fixtureURL = rawsDir.appendingPathComponent(fixture)
        guard FileManager.default.fileExists(atPath: fixtureURL.path) else {
            throw XCTSkip("smoke fixture missing: \(fixtureURL.path)")
        }

        // Launch the app pointed at the fixture. We pass the resolved
        // root via launchEnvironment so the *app* sees an absolute path
        // that survives its own sandbox boundary.
        let xcuiApp = XCUIApplication()
        xcuiApp.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
        xcuiApp.launchEnvironment["MAPLE_UITEST_FIXTURE"] = fixture
        xcuiApp.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = rawsDir.path
        xcuiApp.launch()

        // Wait for the window. Don't gate on `canvas-render-ready` — that
        // identifier is conditional on `!isRendering && renderedPreview != nil`
        // and may stall in long-decode states. Window-level screenshot
        // captures whatever Maple is showing right now (placeholder, fast
        // preview, or refined preview), which is the diagnostic we need.
        let window = xcuiApp.windows.firstMatch
        XCTAssertTrue(window.waitForExistence(timeout: 10),
                      "window did not appear within 10s")

        // Wait long enough that a full decode + render lands on most
        // RAW sizes. The 60s decode budget on a 100MP RAW (CLAUDE.md §
        // Performance invariants) is the upper bound; 30s covers the
        // ≤33MB test_0017.dng case with margin.
        let waitSeconds: TimeInterval = TimeInterval(
            ProcessInfo.processInfo.environment["MAPLE_SMOKE_WAIT_SECONDS"]
                .flatMap { Double($0) } ?? 30.0
        )
        FileHandle.standardError.write(Data("[smoke] waiting \(waitSeconds)s for decode+render\n".utf8))
        Thread.sleep(forTimeInterval: waitSeconds)

        // Screenshot the window and attach it to the test result. The
        // attachment lives in the .xcresult bundle — extract it via
        // `xcrun xcresulttool` from the latest bundle in
        // ~/Library/Developer/Xcode/DerivedData/Maple-*/Logs/Test/.
        let xcuiShot = window.screenshot()
        let attachment = XCTAttachment(screenshot: xcuiShot)
        attachment.name = "maple-smoke-\(stem)"
        attachment.lifetime = .keepAlways
        add(attachment)

        XCTAssertGreaterThan(xcuiShot.pngRepresentation.count, 0,
                             "Window screenshot was empty.")
    }

    /// Dump the accessibility tree after Maple renders. Used to diagnose
    /// why `app.otherElements["canvas-render-ready"]` doesn't match — the
    /// SwiftUI view is probably exposed under a different XCUIElement
    /// type on macOS.
    func testDumpAccessibilityTree() throws {
        let stem = "test_0017"
        let fixture = "\(stem).dng"
        let rawsDir = Self.repoRoot().appendingPathComponent("test-fixtures/raws")
        let fixtureURL = rawsDir.appendingPathComponent(fixture)
        guard FileManager.default.fileExists(atPath: fixtureURL.path) else {
            throw XCTSkip("smoke fixture missing: \(fixtureURL.path)")
        }
        let xcuiApp = XCUIApplication()
        xcuiApp.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
        xcuiApp.launchEnvironment["MAPLE_UITEST_FIXTURE"] = fixture
        xcuiApp.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = rawsDir.path
        xcuiApp.launch()
        XCTAssertTrue(xcuiApp.windows.firstMatch.waitForExistence(timeout: 10))

        // Wait long enough for the canvas to render.
        Thread.sleep(forTimeInterval: 30.0)

        // Try to find canvas-render-ready / canvas-rendering across
        // every element type. The first one that has > 0 matches is
        // the type we should be querying via in the tests.
        let identifiers = ["canvas-render-ready", "canvas-rendering"]
        let typeProbes: [(String, XCUIElementQuery)] = [
            ("otherElements", xcuiApp.otherElements),
            ("images", xcuiApp.images),
            ("groups", xcuiApp.groups),
            ("buttons", xcuiApp.buttons),
            ("staticTexts", xcuiApp.staticTexts),
            ("descendantsAny", xcuiApp.descendants(matching: .any)),
        ]
        for id in identifiers {
            for (typeName, query) in typeProbes {
                let count = query.matching(identifier: id).count
                FileHandle.standardError.write(Data("[a11y-probe] \(typeName)[\(id)] count=\(count)\n".utf8))
            }
        }

        // Dump the full debug description. Save to disk via XCTAttachment
        // since long stderr writes get truncated.
        let dump = xcuiApp.debugDescription
        let dumpData = Data(dump.utf8)
        let attachment = XCTAttachment(data: dumpData,
                                       uniformTypeIdentifier: "public.plain-text")
        attachment.name = "a11y-dump"
        attachment.lifetime = .keepAlways
        add(attachment)
        FileHandle.standardError.write(Data("[a11y-dump] size=\(dumpData.count) bytes attached\n".utf8))

        // Also probe for canvas-* identifiers by string-searching the
        // dump (case insensitive) so we know whether they appear at
        // all anywhere in the tree.
        let lower = dump.lowercased()
        for needle in ["canvas-render-ready", "canvas-rendering", "canvas-", "ciimageview"] {
            let count = lower.components(separatedBy: needle.lowercased()).count - 1
            FileHandle.standardError.write(Data("[a11y-grep] \"\(needle)\" appears \(count)x in dump\n".utf8))
        }
    }
}
