import XCTest

#if os(macOS)
  /// Real window resizing around the same edited asset (#3252), using the
  /// committed gray RAW so this gate never skip-passes for missing local RAWs.
  final class EditorLayoutUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    func testControlsAndEditSurviveCompactAndRegularResize() throws {
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures/synthetic/grey-l018-rggb.dng")
      let driver = try MapleAppDriver.launch(fixtureURL: fixture)
      defer {
        driver.app.terminate()
        driver.cleanupStagedFixture()
      }
      let app = driver.app
      driver.waitForCanvasReady()
      let window = app.windows.firstMatch
      resize(window, width: 1100, height: 800)
      let color = app.buttons["editor-dock-group-color"]
      XCTAssertTrue(color.waitForExistence(timeout: 10))
      color.click()
      let blackWhite = app.descendants(matching: .any)
        .matching(identifier: "editor-bw-toggle").firstMatch
      XCTAssertTrue(blackWhite.waitForExistence(timeout: 5))
      let initial = try XCTUnwrap(blackWhite.value as? String)
      blackWhite.click()
      let edited = try XCTUnwrap(blackWhite.value as? String)
      XCTAssertNotEqual(edited, initial)
      app.typeKey("1", modifierFlags: .command)
      let zoom = app.buttons["editor-pill-zoom"]
      let zoomValue = try XCTUnwrap(zoom.value as? String)

      for width: CGFloat in [800, 600, 1100] {
        resize(window, width: width, height: 800)
        let dock = app.descendants(matching: .any)
          .matching(identifier: "editor-tool-dock").firstMatch
        let panel = app.descendants(matching: .any)
          .matching(identifier: "editor-adjustments-panel").firstMatch
        XCTAssertTrue(dock.exists)
        XCTAssertTrue(panel.exists)
        XCTAssertTrue(color.isSelected, "The active group survives a breakpoint change")
        XCTAssertEqual(blackWhite.value as? String, edited)
        XCTAssertEqual(zoom.value as? String, zoomValue)
        XCTAssertFalse(app.otherElements["editor-iphone-legacy-controls"].exists)
        let editor = app.descendants(matching: .any)
          .matching(identifier: "editor-view").firstMatch
        XCTAssertTrue(editor.exists)
        if editor.frame.width < 768 {
          XCTAssertGreaterThan(dock.frame.width, dock.frame.height)
          XCTAssertLessThanOrEqual(panel.frame.maxY, dock.frame.minY)
        } else {
          XCTAssertGreaterThan(dock.frame.height, dock.frame.width)
          XCTAssertLessThanOrEqual(panel.frame.maxX, dock.frame.minX)
        }
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Shared editor controls at \(Int(width)) points"
        screenshot.lifetime = .keepAlways
        add(screenshot)
      }

      // The pending sidecar and undo history belong to the original session.
      // One undo must still reverse the pre-resize Black & White edit.
      app.buttons["editor-undo"].click()
      XCTAssertEqual(blackWhite.value as? String, initial)
    }

    private func resize(_ window: XCUIElement, width: CGFloat, height: CGFloat) {
      let corner = window.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 1))
        .withOffset(CGVector(dx: -1, dy: -1))
      let target = window.coordinate(withNormalizedOffset: .zero)
        .withOffset(CGVector(dx: width - 1, dy: height - 1))
      corner.press(forDuration: 0.1, thenDragTo: target)
      let resized = XCTNSPredicateExpectation(
        predicate: NSPredicate { _, _ in abs(window.frame.width - width) < 8 }, object: window)
      XCTAssertEqual(XCTWaiter.wait(for: [resized], timeout: 5), .completed)
    }
  }
#endif
