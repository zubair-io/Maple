import XCTest

#if os(iOS) && targetEnvironment(simulator)
  final class PhoneDuoSelectionUITests: XCTestCase {
    func testBrowseSelectionStaysInBrowseAndCanClear() throws {
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures")
        .appendingPathComponent("layout")
        .appendingPathComponent("rgb-gradient.png")
      let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-duo-selection-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      try FileManager.default.copyItem(
        at: fixture, to: directory.appendingPathComponent(fixture.lastPathComponent))

      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = fixture.lastPathComponent
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = directory.path
      app.launchEnvironment["MAPLE_UITEST_START"] = "browse"
      app.launch()
      defer { app.terminate() }

      let select = app.buttons["multi-select-toggle"]
      let tile = app.images["thumb-rgb-gradient"].firstMatch
      XCTAssertTrue(select.waitForExistence(timeout: 10))
      XCTAssertTrue(tile.waitForExistence(timeout: 10))
      select.tap()
      XCTAssertTrue(app.otherElements["phone-selection-bar"].waitForExistence(timeout: 5))
      XCTAssertTrue(tile.label.contains("not selected"))
      tile.tap()
      XCTAssertTrue(tile.label.contains("selected"))
      XCTAssertTrue(app.staticTexts["phone-selection-count"].label.contains("1"))
      XCTAssertFalse(app.otherElements["preview-view"].exists)

      let closedScreenshot = XCTAttachment(screenshot: app.screenshot())
      closedScreenshot.name = "Duo Browse selection closed"
      closedScreenshot.lifetime = .keepAlways
      add(closedScreenshot)

      app.buttons["phone-selection-clear"].tap()
      XCTAssertTrue(tile.label.contains("not selected"))
      app.buttons["phone-select-all"].tap()
      XCTAssertTrue(tile.label.contains("selected"))

      select.tap()
      XCTAssertFalse(app.otherElements["phone-selection-bar"].exists)
      XCTAssertTrue(tile.exists)
    }
  }
#endif
