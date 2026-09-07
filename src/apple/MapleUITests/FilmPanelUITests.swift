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
// The Film dock button reveals FilmSection in the shared stacked inspector
// at every MapleLayout (#3252).

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

    /// A known look from a DIFFERENT category — `black_white`, the first
    /// `FilmCategory.allCases` entry and therefore the default chip
    /// selection whenever no look is armed. Used to prove the chip row
    /// actually switches which category's rows are reachable.
    private static let otherCategoryLookID = "black_white_agfa_apx_100"
    private static let otherCategoryLookName = "Agfa APX 100"

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
      // The decode that needed the staged fixture file has already
      // happened by this point — safe to clean up now rather than leak a
      // maple-uitest-* dir per run (Copilot review on #3193). This
      // helper returns only `app`, not `driver`, so there is no later
      // point a caller could `defer` this from.
      driver.cleanupStagedFixture()

      let app = XCUIApplication()
      let filmButton = app.buttons["editor-dock-tool-filmLook"]
      XCTAssertTrue(
        filmButton.waitForExistence(timeout: 10),
        "Film dock button missing — the film tool lost its only route "
          + "into the shared adjustments panel."
      )
      filmButton.click()
      return app
    }

    func testFilmPanelExposesCategoryChipsAndDefaultsToFirstCategory() throws {
      let app = try launchWithFilmArmed()

      XCTAssertTrue(
        app.otherElements["editor-film-section"].waitForExistence(timeout: 10),
        "Film section did not appear after arming the Film tool."
      )
      XCTAssertTrue(
        app.otherElements["film-category-row"].waitForExistence(timeout: 10),
        "Category chip row did not appear."
      )

      for category in Self.categoryRawValues {
        let chip = app.buttons["film-category-\(category)"]
        XCTAssertTrue(chip.exists, "category chip \(category) missing")
      }

      let noneRow = app.buttons["film-look-none"]
      XCTAssertTrue(noneRow.exists, "\"None\" row missing")
      XCTAssertEqual(noneRow.label, "None film look")

      // No look armed yet — defaults to the first category (black_white),
      // so its rows are reachable without switching chips...
      let defaultCategoryRow = app.buttons["film-look-row-\(Self.otherCategoryLookID)"]
      XCTAssertTrue(
        defaultCategoryRow.exists,
        "default-category (black_white) row \(Self.otherCategoryLookID) missing"
      )
      XCTAssertEqual(defaultCategoryRow.label, "\(Self.otherCategoryLookName) film look")

      // ...while a DIFFERENT category's row is not shown until its chip
      // is selected — proves the list is actually filtered, not just the
      // chip row cosmetically added on top of the old flat scroll.
      XCTAssertFalse(
        app.buttons["film-look-row-\(Self.knownLookID)"].exists,
        "color_negative row must not be reachable while black_white is selected"
      )

      // No look is armed yet — the strength slider only surfaces once one
      // is picked.
      XCTAssertFalse(app.otherElements["slider-film-strength"].exists)
    }

    func testSwitchingCategoryChipShowsThatCategorysLooks() throws {
      let app = try launchWithFilmArmed()

      XCTAssertTrue(
        app.otherElements["film-category-row"].waitForExistence(timeout: 10),
        "Category chip row did not appear."
      )

      // Defaults to black_white — switch to color_negative via its chip.
      let colorNegativeChip = app.buttons["film-category-color_negative"]
      XCTAssertTrue(colorNegativeChip.waitForExistence(timeout: 10))
      colorNegativeChip.click()

      let knownRow = app.buttons["film-look-row-\(Self.knownLookID)"]
      XCTAssertTrue(
        knownRow.waitForExistence(timeout: 10),
        "known look row \(Self.knownLookID) did not appear after selecting its category chip"
      )
      XCTAssertEqual(knownRow.label, "\(Self.knownLookName) film look")

      // The None row stays pinned above the list regardless of category.
      XCTAssertTrue(
        app.buttons["film-look-none"].exists, "\"None\" row missing after switching category")

      // The previously-default category's row is no longer reachable.
      XCTAssertFalse(
        app.buttons["film-look-row-\(Self.otherCategoryLookID)"].exists,
        "black_white row must not be reachable after switching to color_negative"
      )
    }

    func testSelectingALookRevealsTheStrengthSlider() throws {
      let app = try launchWithFilmArmed()

      // The known look lives in color_negative; black_white is the
      // default chip selection, so switch categories first.
      let colorNegativeChip = app.buttons["film-category-color_negative"]
      XCTAssertTrue(colorNegativeChip.waitForExistence(timeout: 10))
      colorNegativeChip.click()

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
#endif  // os(macOS)
