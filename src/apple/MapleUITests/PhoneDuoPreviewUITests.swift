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

      app.buttons["preview-info"].tap()
      XCTAssertTrue(app.scrollViews["info-panel"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.otherElements["info-panel-rating-flags"].isHittable)

      let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
      screenshot.name = "Duo Preview compact Info"
      screenshot.lifetime = .keepAlways
      add(screenshot)
    }
  }
#endif
