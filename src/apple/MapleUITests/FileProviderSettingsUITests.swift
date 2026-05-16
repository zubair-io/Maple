import XCTest

final class FileProviderSettingsUITests: XCTestCase {
    /// Smoke test that the Finder settings tab renders. The tab lists the
    /// servers from CloudServerRegistry — on a fresh test runner with no
    /// paired servers, the empty-state message must surface. Live enable
    /// / disable / refresh against a real server is exercised manually
    /// per the Phase 1 plan, not here.
    func testFinderTabRenders() throws {
        let app = XCUIApplication()
        app.launch()
        app.activate()

        // Open Settings — macOS uses Cmd+Comma.
        app.typeKey(",", modifierFlags: .command)

        // Click the Finder tab (the Settings TabView opens on whichever
        // tab was last visited; we explicitly navigate to ours).
        let finderTab = app.buttons["Finder"]
        if finderTab.waitForExistence(timeout: 5) {
            finderTab.click()
        }

        // On a fresh runner CloudServerRegistry is empty, so the
        // no-servers callout must appear. If a tester has paired
        // servers, the test still passes — we just look for either
        // the empty-state ID or an Enable button.
        let emptyState = app.staticTexts["file-provider-no-servers"]
        let anyEnableButton = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'file-provider-enable-'")).firstMatch
        let exists = emptyState.waitForExistence(timeout: 3) || anyEnableButton.exists
        XCTAssertTrue(exists, "Finder tab should show either the empty state or per-server rows")
    }
}
