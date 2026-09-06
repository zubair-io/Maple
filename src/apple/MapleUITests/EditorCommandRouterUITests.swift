import XCTest

#if os(macOS)
  final class EditorCommandRouterUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    func testFocusedSliderHistoryComparisonAndZoomCommands() throws {
      let driver = try MapleAppDriver.launch(fixture: "test_0017.dng")
      defer { driver.cleanupStagedFixture() }
      let app = driver.app
      defer { app.terminate() }
      driver.waitForCanvasReady()
      let before = XCTAttachment(screenshot: app.screenshot())
      before.name = "Editor before keyboard adjustments"
      before.lifetime = .keepAlways
      add(before)

      let slider = app.descendants(matching: .any).matching(identifier: "editor-slider-exposure")
        .firstMatch
      XCTAssertTrue(slider.waitForExistence(timeout: 10))
      let initial = try XCTUnwrap(slider.value as? String)
      slider.click()
      app.typeKey(.rightArrow, modifierFlags: [])
      let adjusted = try XCTUnwrap(slider.value as? String)
      XCTAssertNotEqual(adjusted, initial, "The focused slider must consume its arrow")
      app.typeKey(.rightArrow, modifierFlags: .shift)
      let shifted = try XCTUnwrap(slider.value as? String)
      XCTAssertEqual(
        try numeric(shifted) - numeric(adjusted), try numeric(adjusted) - numeric(initial),
        accuracy: 0.0001, "Focused Shift+Arrow uses the same generated step as web")
      app.typeKey("z", modifierFlags: .command)
      assertValue(adjusted, on: slider)
      app.typeKey("z", modifierFlags: .command)
      assertValue(initial, on: slider)
      app.typeKey("z", modifierFlags: [.command, .shift])
      assertValue(adjusted, on: slider)

      let zoom = app.buttons["canvas-zoom-indicator"]
      app.typeKey("1", modifierFlags: .command)
      assertValue("Zoom 100 percent", on: zoom)
      let rectangle = app.otherElements["canvas-image-rect"]
      let centered = try XCTUnwrap(rectangle.value as? String)
      app.typeKey(.rightArrow, modifierFlags: .option)
      XCTAssertNotEqual(
        rectangle.value as? String, centered, "Option-arrow must pan, not edit the focused slider")
      let panned = try XCTUnwrap(rectangle.value as? String)
      app.typeKey("b", modifierFlags: [])
      let original = app.otherElements["editor-original-preview"]
      XCTAssertTrue(original.waitForExistence(timeout: 10))
      assertValue("Original ready", on: original)
      assertValue(panned, on: rectangle)
      app.typeKey("b", modifierFlags: [])
      XCTAssertTrue(original.waitForNonExistence(timeout: 10))
      assertValue(panned, on: rectangle)
      app.typeKey("0", modifierFlags: .command)
      XCTAssertNotEqual(zoom.value as? String, "Zoom 100 percent")

      let after = XCTAttachment(screenshot: app.screenshot())
      after.name = "Keyboard adjustment restored after comparison"
      after.lifetime = .keepAlways
      add(after)
    }

    private func numeric(_ value: String) throws -> Double {
      try XCTUnwrap(Double(value.replacingOccurrences(of: "−", with: "-")))
    }

    private func assertValue(
      _ value: String, on element: XCUIElement, file: StaticString = #filePath, line: UInt = #line
    ) {
      let expectation = XCTNSPredicateExpectation(
        predicate: NSPredicate(format: "value == %@", value), object: element)
      XCTAssertEqual(
        XCTWaiter.wait(for: [expectation], timeout: 30), .completed, file: file, line: line)
    }
  }
#endif
