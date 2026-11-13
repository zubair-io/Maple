import XCTest

#if os(macOS)
  /// The white-balance pad in the Mac inspector (#5121): it is reachable
  /// under the Color group, a drag sets temperature and tint as one Undo
  /// step with Manual provenance, and each arrow-key press steps it once.
  final class WhiteBalancePadUITests: XCTestCase {
    func testPadDragAndArrowKeyPressesAreEachOneUndoStep() throws {
      continueAfterFailure = false
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures/synthetic/grey-l018-rggb.dng")
      let driver = try MapleAppDriver.launch(fixtureURL: fixture)
      defer {
        driver.app.terminate()
        driver.cleanupStagedFixture()
      }
      driver.waitForCanvasReady()
      let app = driver.app
      app.buttons["editor-dock-group-color"].click()

      let pad = app.descendants(matching: .any).matching(identifier: "editor-wb-pad").firstMatch
      XCTAssertTrue(pad.waitForExistence(timeout: 10), "White-balance pad is not reachable")
      XCTAssertEqual(pad.label, "White balance pad")
      let provenance = app.staticTexts["editor-wb-provenance"]
      XCTAssertTrue(provenance.waitForExistence(timeout: 5))
      let initialValue = try XCTUnwrap(pad.value as? String)
      let initialProvenance = try XCTUnwrap(provenance.value as? String)

      // A pointer over the pad previews the pair a press would set.
      pad.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.3)).hover()
      attach(app, "Pointer hovering over the pad")

      // One drag: both axes move, provenance turns Manual, one Undo undoes it.
      pad.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5))
        .press(
          forDuration: 0.1,
          thenDragTo: pad.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.25)))
      wait(pad, toHaveValueOtherThan: initialValue)
      let dragged = try XCTUnwrap(pad.value as? String)
      XCTAssertTrue(dragged.hasPrefix("Temperature "), dragged)
      wait(provenance, value: "White balance: Manual")
      attach(app, "After a pad drag")
      app.buttons["editor-undo"].click()
      wait(pad, value: initialValue)
      wait(provenance, value: initialProvenance)

      // A click places the handle and leaves the pad focused; each arrow
      // press after it is a step of its own, as on a slider.
      pad.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).click()
      wait(pad, toHaveValueOtherThan: initialValue)
      let clicked = try XCTUnwrap(pad.value as? String)
      var stepped = [clicked]
      for _ in 0..<3 {
        app.typeKey(.rightArrow, modifierFlags: [])
        wait(pad, toHaveValueOtherThan: stepped[stepped.count - 1])
        stepped.append(try XCTUnwrap(pad.value as? String))
      }
      attach(app, "After arrow keys")
      for value in stepped.dropLast().reversed() {
        app.buttons["editor-undo"].click()
        wait(pad, value: value)
      }
      app.buttons["editor-undo"].click()
      wait(pad, value: initialValue)
    }

    private func wait(_ element: XCUIElement, value: String) {
      let reached = XCTNSPredicateExpectation(
        predicate: NSPredicate(format: "value == %@", value), object: element)
      XCTAssertEqual(XCTWaiter.wait(for: [reached], timeout: 30), .completed)
    }

    private func wait(_ element: XCUIElement, toHaveValueOtherThan value: String) {
      let changed = XCTNSPredicateExpectation(
        predicate: NSPredicate(format: "value != %@", value), object: element)
      XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 30), .completed)
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
      let screenshot = XCTAttachment(screenshot: app.screenshot())
      screenshot.name = name
      screenshot.lifetime = .keepAlways
      add(screenshot)
    }
  }
#endif
