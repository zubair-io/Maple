import XCTest

#if os(macOS)
  final class WhiteBalancePresetUITests: XCTestCase {
    func testNamedPresetAndAutoAreReachableAndUndoable() throws {
      continueAfterFailure = false
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures/synthetic/grey-l018-rggb.dng")
      let driver = try MapleAppDriver.launch(
        fixtureURL: fixture, launchArguments: ["-proControlVariant", "compact"])
      defer {
        driver.app.terminate()
        driver.cleanupStagedFixture()
      }
      driver.waitForCanvasReady()
      let app = driver.app
      app.buttons["editor-dock-group-color"].click()
      let picker = app.popUpButtons["editor-wb-preset"]
      XCTAssertTrue(picker.waitForExistence(timeout: 10))
      let provenance = app.staticTexts["editor-wb-provenance"]
      XCTAssertTrue(provenance.waitForExistence(timeout: 5))
      let initial = provenance.label
      attach(app, "Before preset selection")
      picker.click()
      for name in [
        "As Shot", "Auto", "Daylight", "Cloudy", "Shade", "Tungsten", "Fluorescent", "Flash",
        "Custom",
      ] {
        XCTAssertTrue(app.menuItems[name].exists, "Missing \(name) choice")
      }
      app.menuItems["Shade"].click()
      waitForLabel(provenance, "White balance: Shade")
      attach(app, "Shade white balance")
      app.buttons["editor-undo"].click()
      waitForLabel(provenance, initial)
      picker.click()
      app.menuItems["Auto"].click()
      let autoSource = XCTNSPredicateExpectation(
        predicate: NSPredicate(
          format: "label MATCHES %@", "White balance: Auto · version [1-9][0-9]*"),
        object: provenance)
      XCTAssertEqual(XCTWaiter.wait(for: [autoSource], timeout: 60), .completed)
      attach(app, "Auto white balance")
      app.buttons["editor-undo"].click()
      waitForLabel(provenance, initial)
    }

    private func waitForLabel(_ element: XCUIElement, _ label: String) {
      let changed = XCTNSPredicateExpectation(
        predicate: NSPredicate(format: "label == %@", label), object: element)
      XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 60), .completed)
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
      let screenshot = XCTAttachment(screenshot: app.screenshot())
      screenshot.name = name
      screenshot.lifetime = .keepAlways
      add(screenshot)
    }
  }
#endif
