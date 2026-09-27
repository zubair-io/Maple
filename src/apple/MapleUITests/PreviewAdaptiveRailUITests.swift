import XCTest

#if os(iOS) && targetEnvironment(simulator)
  final class PreviewAdaptiveRailUITests: XCTestCase {
    override func setUpWithError() throws {
      continueAfterFailure = false
      XCUIDevice.shared.orientation = .landscapeLeft
    }

    override func tearDownWithError() throws {
      XCUIDevice.shared.orientation = .portrait
    }

    func testWidePreviewRailListAndInfoPreserveActiveAsset() throws {
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures/layout/rgb-gradient.png")
      let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-preview-rail-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      try FileManager.default.copyItem(
        at: fixture, to: directory.appendingPathComponent(fixture.lastPathComponent))

      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = fixture.lastPathComponent
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = directory.path
      app.launch()
      defer { app.terminate() }

      // The iPad fixture route enters Editor. Its production Back action
      // returns to Preview with the same selected asset.
      XCTAssertTrue(element("editor-back", in: app).waitForExistence(timeout: 20))
      element("editor-back", in: app).tap()
      XCTAssertTrue(element("preview-view", in: app).waitForExistence(timeout: 10))

      let filename = element("preview-filename", in: app)
      let displayName = fixture.deletingPathExtension().lastPathComponent
      XCTAssertTrue(filename.exists)
      XCTAssertEqual(filename.label, displayName)

      let rail = element("preview-navigation-rail", in: app)
      XCTAssertTrue(rail.waitForExistence(timeout: 5), "Wide Preview should show its left rail")
      XCTAssertTrue(element("preview-filmstrip-rail", in: app).exists)

      let toggle = app.buttons["preview-navigation-toggle"]
      XCTAssertTrue(toggle.exists)
      XCTAssertEqual(toggle.label, "Show photo list")
      toggle.tap()
      XCTAssertTrue(element("preview-photo-list", in: app).waitForExistence(timeout: 5))
      XCTAssertEqual(toggle.label, "Show filmstrip")
      XCTAssertEqual(filename.label, displayName)
      XCTAssertTrue(app.buttons[displayName].exists)

      toggle.tap()
      XCTAssertTrue(element("preview-filmstrip-rail", in: app).waitForExistence(timeout: 5))
      XCTAssertEqual(filename.label, displayName)

      let info = app.buttons["preview-info"]
      XCTAssertTrue(info.exists)
      let panel = element("info-panel", in: app)
      if info.isSelected {
        info.tap()
        XCTAssertFalse(info.isSelected)
      }
      info.tap()
      XCTAssertTrue(info.isSelected, "Info should become selected after opening")
      XCTAssertTrue(panel.waitForExistence(timeout: 5))
      let panelVisible = XCTNSPredicateExpectation(
        predicate: NSPredicate(format: "hittable == YES"), object: panel)
      XCTAssertEqual(XCTWaiter.wait(for: [panelVisible], timeout: 5), .completed)
      XCTAssertTrue(element("info-panel-rating-flags", in: app).isHittable)
      XCTAssertLessThanOrEqual(panel.frame.maxX, app.frame.maxX)
      XCTAssertGreaterThanOrEqual(panel.frame.minX, app.frame.minX)
      XCTAssertEqual(filename.label, displayName)
      let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
      screenshot.name = "Wide Preview rail with Info"
      screenshot.lifetime = .keepAlways
      add(screenshot)
    }

    private func element(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
      app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }
  }
#endif
