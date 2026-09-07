import XCTest

#if os(macOS)
  final class CanvasZoomCommandsUITests: XCTestCase {
    override func setUpWithError() throws {
      continueAfterFailure = false
    }

    /// Drives the real scene commands and both pointer affordances. A fit
    /// readout alone would miss a broken route from keyboard/menu to canvas.
    func testFitAndActualSizeFromKeyboardMenuAndReadouts() throws {
      let driver = try MapleAppDriver.launch(fixture: "test_0017.dng")
      defer { driver.cleanupStagedFixture() }
      let app = driver.app
      defer { app.terminate() }
      driver.waitForCanvasReady()

      let badge = app.buttons["canvas-zoom-indicator"]
      XCTAssertTrue(badge.waitForExistence(timeout: 10))
      let fitValue = try XCTUnwrap(badge.value as? String)
      let imageRect = app.otherElements["canvas-image-rect"]
      let fitRect = try XCTUnwrap(imageRect.value as? String)
      XCTAssertNotEqual(fitValue, "Zoom 100 percent", "The fixture must fit below actual size.")
      let before = XCTAttachment(screenshot: app.screenshot())
      before.name = "Initial fit"
      before.lifetime = .keepAlways
      add(before)

      app.typeKey("1", modifierFlags: .command)
      assertValue("Zoom 100 percent", on: badge)
      XCTAssertNotEqual(imageRect.value as? String, fitRect, "Actual Size must reframe the canvas.")
      app.typeKey("0", modifierFlags: .command)
      assertValue(fitValue, on: badge)
      assertValue(fitRect, on: imageRect)

      app.typeKey("1", modifierFlags: .command)
      assertValue("Zoom 100 percent", on: badge)
      badge.click()
      assertValue(fitValue, on: badge)

      app.typeKey("1", modifierFlags: .command)
      assertValue("Zoom 100 percent", on: badge)
      app.buttons["editor-pill-zoom"].click()
      assertValue(fitValue, on: badge)

      let slider = app.descendants(matching: .any)
        .matching(identifier: "editor-slider-exposure").firstMatch
      XCTAssertTrue(slider.waitForExistence(timeout: 10))
      slider.click()
      // The scene router keeps Zoom available while a control outside
      // CanvasZoomHost owns focus; the canvas controller is only a fallback.
      openZoomMenu(in: app)
      app.menuItems["Actual Size (100%)"].click()
      assertValue("Zoom 100 percent", on: badge)
      slider.click()
      openZoomMenu(in: app)
      app.menuItems["Zoom to Fit"].click()
      assertValue(fitValue, on: badge)
      assertValue(fitRect, on: imageRect)

      let after = XCTAttachment(screenshot: app.screenshot())
      after.name = "Fit restored through View menu"
      after.lifetime = .keepAlways
      add(after)

      app.buttons["editor-back"].click()
      XCTAssertTrue(badge.waitForNonExistence(timeout: 10))
      app.menuBars.menuBarItems["View"].click()
      XCTAssertFalse(
        app.menuItems["Zoom"].isEnabled, "Browse must not retain the editor's Zoom commands.")
      app.typeKey(.escape, modifierFlags: [])
    }

    private func openZoomMenu(in app: XCUIApplication) {
      app.menuBars.menuBarItems["View"].click()
      let zoom = app.menuItems["Zoom"]
      XCTAssertTrue(zoom.isEnabled)
      zoom.hover()
      XCTAssertTrue(app.menuItems["Zoom to Fit"].waitForExistence(timeout: 5))
    }

    private func assertValue(
      _ value: String, on element: XCUIElement,
      file: StaticString = #filePath, line: UInt = #line
    ) {
      let expectation = XCTNSPredicateExpectation(
        predicate: NSPredicate(format: "value == %@", value), object: element)
      XCTAssertEqual(
        XCTWaiter.wait(for: [expectation], timeout: 10), .completed,
        "Expected accessibility value: \(value)", file: file, line: line)
    }
  }
#endif
