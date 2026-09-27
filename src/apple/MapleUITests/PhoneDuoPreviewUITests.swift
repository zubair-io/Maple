import XCTest

#if os(iOS) && targetEnvironment(simulator)
  final class PhoneDuoPreviewUITests: XCTestCase {
    func testCompactPreviewHasOneHeaderAndRealInfo() throws {
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures")
        .appendingPathComponent("layout")
        .appendingPathComponent("rgb-gradient.png")
      let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-duo-preview-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      try FileManager.default.copyItem(
        at: fixture, to: directory.appendingPathComponent(fixture.lastPathComponent))

      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = fixture.lastPathComponent
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = directory.path
      app.launchEnvironment["MAPLE_UITEST_START"] = "preview"
      app.launch()
      defer { app.terminate() }

      XCTAssertTrue(app.otherElements["preview-view"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.otherElements["preview-header"].exists)
      XCTAssertTrue(app.buttons["preview-back"].exists)
      XCTAssertTrue(app.buttons["preview-edit"].exists)
      XCTAssertTrue(app.buttons["preview-info"].exists)
      XCTAssertTrue(app.staticTexts["preview-filename"].exists)
      XCTAssertFalse(app.buttons["multi-select-toggle"].exists)
      XCTAssertFalse(app.buttons["preview-info"].isSelected)
      XCTAssertFalse(app.scrollViews["info-panel"].exists)

      app.buttons["preview-info"].tap()
      XCTAssertTrue(app.scrollViews["info-panel"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.otherElements["info-panel-rating-flags"].isHittable)

      let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
      screenshot.name = "Duo Preview compact Info"
      screenshot.lifetime = .keepAlways
      add(screenshot)
    }

    func testWidePhonePreviewInfoStartsClosedAndOpensOnTap() throws {
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures/layout/rgb-gradient.png")
      let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-duo-wide-preview-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      try FileManager.default.copyItem(
        at: fixture, to: directory.appendingPathComponent(fixture.lastPathComponent))

      XCUIDevice.shared.orientation = .landscapeLeft
      defer { XCUIDevice.shared.orientation = .portrait }
      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = fixture.lastPathComponent
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = directory.path
      app.launchEnvironment["MAPLE_UITEST_START"] = "preview"
      app.launch()
      defer { app.terminate() }

      XCTAssertTrue(app.otherElements["preview-view"].waitForExistence(timeout: 10))
      XCTAssertTrue(app.otherElements["preview-navigation-rail"].exists)
      let info = app.buttons["preview-info"]
      XCTAssertFalse(info.isSelected, "Wide phone Preview must not restore the Info preference")
      let panel = app.scrollViews["info-panel"]
      XCTAssertFalse(panel.exists)

      info.tap()
      XCTAssertTrue(info.isSelected)
      XCTAssertTrue(panel.waitForExistence(timeout: 5))
      XCTAssertTrue(panel.isHittable)
    }
  }
#endif
