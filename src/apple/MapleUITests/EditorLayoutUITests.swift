import XCTest

#if os(macOS)
  /// Resize the same edited image (#3252). This committed RGB fixture exercises
  /// the live canvas, controls, history and crop geometry in clean checkouts.
  /// Separate camera RAW harnesses cover decode and color parity.
  final class EditorLayoutUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    func testControlsAndEditSurviveCompactAndRegularResize() throws {
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures/layout/rgb-gradient.png")
      let driver = try MapleAppDriver.launch(fixtureURL: fixture)
      defer {
        if let testRun, testRun.failureCount > 0 {
          let tree = XCTAttachment(string: driver.app.debugDescription)
          tree.name = "Editor layout accessibility tree"
          tree.lifetime = .keepAlways
          add(tree)
        }
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

      for width: CGFloat in [800, 700, 1100] {
        // A breakpoint change must reveal the armed Color tool even when
        // its section was deliberately collapsed beforehand.
        color.click()
        let colorSection = app.buttons["editor-panel-section-color"]
        XCTAssertEqual(colorSection.value as? String, "Expanded")
        colorSection.click()
        let collapsed = XCTNSPredicateExpectation(
          predicate: NSPredicate(format: "value == 'Collapsed'"), object: colorSection)
        XCTAssertEqual(XCTWaiter.wait(for: [collapsed], timeout: 5), .completed)
        XCTAssertFalse(blackWhite.exists)
        resize(window, width: width, height: 800)
        XCTAssertTrue(blackWhite.waitForExistence(timeout: 5))
        XCTAssertEqual(colorSection.value as? String, "Expanded")
        let visible = XCTNSPredicateExpectation(
          predicate: NSPredicate { _, _ in blackWhite.isHittable }, object: blackWhite)
        XCTAssertEqual(XCTWaiter.wait(for: [visible], timeout: 5), .completed)
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

      for size in [
        CGSize(width: 700, height: 800), CGSize(width: 1100, height: 800),
        CGSize(width: 700, height: 450),
      ] {
        let width = size.width
        resize(window, width: width, height: size.height)
        app.buttons["editor-dock-tool-crop"].click()
        XCTAssertTrue(app.buttons["editor-crop-done"].waitForExistence(timeout: 5))
        let panel = app.descendants(matching: .any)
          .matching(identifier: "editor-adjustments-panel").firstMatch
        let clearHandles = XCTNSPredicateExpectation(
          predicate: NSPredicate { _, _ in
            let canvas = driver.canvasElement().frame
            return canvas.width > 90 && canvas.height > 90
              && (width == 700
                ? canvas.maxY < panel.frame.minY : canvas.maxX < panel.frame.minX)
          }, object: panel)
        XCTAssertEqual(
          XCTWaiter.wait(for: [clearHandles], timeout: 5), .completed,
          "Crop handles must clear the inspector after reflow")
        app.buttons["editor-crop-done"].click()
      }

      // Main's wired Mask surface keeps an entry in the shared dock after
      // the legacy mobile and stacked tool rows are consolidated.
      for width: CGFloat in [700, 1100] {
        resize(window, width: width, height: 800)
        let mask = app.buttons["editor-dock-tool-mask"]
        XCTAssertTrue(mask.exists)
        mask.click()
        let maskPanel = app.descendants(matching: .any)
          .matching(identifier: "editor-mask-panel").firstMatch
        XCTAssertTrue(maskPanel.waitForExistence(timeout: 5))
        let addMask = app.buttons["editor-mask-add-menu"]
        XCTAssertTrue(addMask.waitForExistence(timeout: 5))
        let reachable = XCTNSPredicateExpectation(
          predicate: NSPredicate { _, _ in addMask.isHittable }, object: addMask)
        XCTAssertEqual(
          XCTWaiter.wait(for: [reachable], timeout: 5), .completed,
          "The armed Mask panel must reveal its Add Mask action")
        let panel = app.descendants(matching: .any)
          .matching(identifier: "editor-adjustments-panel").firstMatch
        XCTAssertTrue(panel.exists)
        let editor = app.descendants(matching: .any)
          .matching(identifier: "editor-view").firstMatch
        if editor.frame.width < 768 {
          XCTAssertLessThan(
            panel.frame.height, editor.frame.height * 0.5,
            "The scrollable Mask inspector must leave room for the photo on compact widths")
        }
      }
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
