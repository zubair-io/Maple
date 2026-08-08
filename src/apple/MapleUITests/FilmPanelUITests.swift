// FilmPanelUITests.swift — presence/reachability gate for the Film widget
// (#2683).
//
// Sibling of `ToneCurvePanelUITests.testToneCurvePanelExposesItsControls`,
// same shape and same reason: XCUITest automation-mode is blocked on this
// development Mac (#2525 — every class times out "enabling automation
// mode"), so this file is written to the harness's existing pattern and
// verified structurally rather than run locally. It asserts the controls
// `FilmSection` promises are present and labelled — CI or another machine
// runs it for real.
//
// The panel is reached by arming the Film tool through the dock button
// (`editor-dock-tool-filmLook`), the same route Tone Curve uses: Film has
// no primary field (the catalog pick is a string id, not a drag-bar
// value), so `LivingSliderGrid` filters it out of the Effects group's
// slider stack and the dock is its only route in on macOS-regular. That
// variant mounts `FlyoutSliderPanel`, which swaps in `FilmSection` while
// the tool is armed.
//
// No pixel golden here (unlike `ToneCurvePanelUITests`): a 100-row
// scrollable catalog list is a poor screenshot-diff target — most of it is
// off-screen at any one time, and the ACTUAL visual risk (wrong colour
// science) is already covered by the perceptual harness
// (`src/scripts/test_color_pipeline.sh`) once a look is selected. This
// file covers the regression a screenshot diff cannot see at all: the
// controls existing, being reachable, and being labelled.

import XCTest

// Same `os(macOS)` gate as `MapleUITests` / `ToneCurvePanelUITests`:
// `MapleAppDriver` drives AppKit / XCUIApplication, so the target still
// compiles for the iOS Simulator (which `PanoOrtSelftestUITests` needs).
#if os(macOS)
final class FilmPanelUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// A catalog id known to exist in `FilmCatalog.all` — kept here as a
    /// literal (not re-derived from `MapleCore`, which this UI-test target
    /// does not link) so the test still catches a catalog id that changed
    /// or a category that got dropped.
    private static let knownLookID = "color_negative_kodak_portra_400"
    private static let knownLookName = "Kodak Portra 400"

    /// The six `FilmCategory` raw values, in `FilmCategory.allCases`
    /// declaration order (mirrors `Generated/FilmCatalog+Generated.swift`).
    private static let categoryRawValues = [
        "black_white", "cinema_print", "color_negative",
        "consumer_vintage", "instant", "slide",
    ]

    /// Arm the Film tool and return the running app, or skip when the
    /// fixture is absent (mirrors every other harness in this target).
    private func launchWithFilmArmed() throws -> XCUIApplication {
        let driver = try MapleAppDriver.launch(fixture: "test_0017.dng")
        driver.waitForCanvasReady(timeout: 30)

        let app = XCUIApplication()
        let filmButton = app.buttons["editor-dock-tool-filmLook"]
        XCTAssertTrue(
            filmButton.waitForExistence(timeout: 10),
            "Film dock button missing — the film tool lost its only route "
                + "into the default control variant."
        )
        filmButton.click()
        return app
    }

    func testFilmPanelExposesCategoriesAndLooks() throws {
        let app = try launchWithFilmArmed()

        XCTAssertTrue(
            app.otherElements["editor-film-section"].waitForExistence(timeout: 10),
            "Film section did not appear after arming the Film tool."
        )

        for category in Self.categoryRawValues {
            let header = app.staticTexts["film-category-\(category)"]
            XCTAssertTrue(header.exists, "category header \(category) missing")
        }

        let noneRow = app.buttons["film-look-none"]
        XCTAssertTrue(noneRow.exists, "\"None\" row missing")
        XCTAssertEqual(noneRow.label, "None film look")

        let knownRow = app.buttons["film-look-row-\(Self.knownLookID)"]
        XCTAssertTrue(knownRow.exists, "known look row \(Self.knownLookID) missing")
        XCTAssertEqual(knownRow.label, "\(Self.knownLookName) film look")

        // No look is armed yet — the strength slider only surfaces once one
        // is picked.
        XCTAssertFalse(app.otherElements["slider-film-strength"].exists)
    }

    func testSelectingALookRevealsTheStrengthSlider() throws {
        let app = try launchWithFilmArmed()

        let knownRow = app.buttons["film-look-row-\(Self.knownLookID)"]
        XCTAssertTrue(knownRow.waitForExistence(timeout: 10))
        knownRow.click()

        let slider = app.otherElements["slider-film-strength"]
        XCTAssertTrue(
            slider.waitForExistence(timeout: 10),
            "Strength slider did not appear after selecting a look."
        )
        XCTAssertEqual(slider.label, "Strength")
    }
}
#endif // os(macOS)
