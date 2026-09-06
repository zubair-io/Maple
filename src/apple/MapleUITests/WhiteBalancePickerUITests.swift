import XCTest

#if os(macOS)
  /// Exercises the actual Apple controls and native RAW sampler (#3308). The
  /// committed, uniform gray DNG makes every interior point a valid neutral;
  /// missing fixtures fail instead of silently skipping this interaction gate.
  final class WhiteBalancePickerUITests: XCTestCase {
    override func setUpWithError() throws {
      continueAfterFailure = false
    }

    func testNeutralPickCancellationProvenanceAndUndo() throws {
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures/synthetic/grey-l018-rggb.dng")
      let driver = try MapleAppDriver.launch(
        fixtureURL: fixture, launchArguments: ["-proControlVariant", "compact"])
      defer {
        if let testRun, testRun.failureCount > 0 {
          let tree = XCTAttachment(string: driver.app.debugDescription)
          tree.name = "White balance accessibility tree"
          tree.lifetime = .keepAlways
          add(tree)
        }
        driver.app.terminate()
        driver.cleanupStagedFixture()
      }
      driver.waitForCanvasReady()
      let app = driver.app
      let color = app.buttons["editor-dock-group-color"]
      XCTAssertTrue(color.waitForExistence(timeout: 10), "Color dock group must be reachable")
      color.click()

      let eyedropper = app.buttons["editor-wb-eyedropper"]
      let provenance = app.staticTexts["editor-wb-provenance"]
      let cancel = app.buttons["editor-wb-pick-cancel"]
      XCTAssertTrue(eyedropper.waitForExistence(timeout: 5))
      XCTAssertTrue(eyedropper.isEnabled)
      XCTAssertTrue(provenance.waitForExistence(timeout: 5))
      let initialSource = provenance.label
      XCTAssertEqual(initialSource, "White balance: As Shot")
      attachScreenshot(app, name: "White balance before pick")

      // Escape must reach the armed canvas even though keyboard focus began on
      // the sibling eyedropper button. Neither cancel path creates an edit.
      eyedropper.click()
      XCTAssertTrue(cancel.waitForExistence(timeout: 5))
      app.typeKey(.escape, modifierFlags: [])
      waitForAbsence(cancel)
      XCTAssertEqual(provenance.label, initialSource)

      eyedropper.click()
      XCTAssertTrue(cancel.waitForExistence(timeout: 5))
      cancel.click()
      waitForAbsence(cancel)
      XCTAssertEqual(provenance.label, initialSource)

      eyedropper.click()
      XCTAssertTrue(cancel.waitForExistence(timeout: 5))
      driver.waitForCanvasReady()
      // This is a spatial photo interaction, located from the live accessibility
      // frame rather than a screen coordinate. The bottom-left interior avoids
      // both the flyout at the right edge and the instruction card at the top.
      driver.canvasElement().coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.75)).click()
      let sampled = XCTNSPredicateExpectation(
        predicate: NSPredicate(format: "label BEGINSWITH %@", "White balance: Sampled"),
        object: provenance)
      XCTAssertEqual(XCTWaiter.wait(for: [sampled], timeout: 30), .completed)
      XCTAssertNotNil(
        provenance.label.range(
          of: #"Sampled · \(0\.\d{3}, 0\.\d{3}\) · version [1-9]\d*"#,
          options: .regularExpression),
        "A successful pick must expose its normalized point and algorithm version")
      waitForAbsence(cancel)
      attachScreenshot(app, name: "White balance sampled provenance")

      let undo = app.buttons["editor-undo"]
      XCTAssertTrue(undo.waitForExistence(timeout: 5))
      XCTAssertTrue(undo.isEnabled)
      undo.click()
      let restored = XCTNSPredicateExpectation(
        predicate: NSPredicate(format: "label == %@", initialSource), object: provenance)
      XCTAssertEqual(XCTWaiter.wait(for: [restored], timeout: 5), .completed)
    }

    private func waitForAbsence(
      _ element: XCUIElement, file: StaticString = #filePath, line: UInt = #line
    ) {
      let absent = XCTNSPredicateExpectation(
        predicate: NSPredicate(format: "exists == false"), object: element)
      XCTAssertEqual(
        XCTWaiter.wait(for: [absent], timeout: 5), .completed,
        "White balance picking should end", file: file, line: line)
    }

    private func attachScreenshot(_ app: XCUIApplication, name: String) {
      let attachment = XCTAttachment(screenshot: app.screenshot())
      attachment.name = name
      attachment.lifetime = .keepAlways
      add(attachment)
    }
  }
#endif
