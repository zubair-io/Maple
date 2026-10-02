import XCTest

#if os(macOS)
  final class EditorAutoUITests: XCTestCase {
    func testAutoIsReachableAndCreatesOneUndoEntry() throws {
      continueAfterFailure = false
      let driver = try MapleAppDriver.launch(fixture: "test_0017.dng")
      defer { driver.cleanupStagedFixture() }
      driver.waitForCanvasReady(timeout: 45)
      let app = XCUIApplication()
      let auto = app.buttons["editor-auto"]
      let undo = app.buttons["editor-undo"]
      XCTAssertTrue(auto.waitForExistence(timeout: 10))
      XCTAssertTrue(auto.isEnabled)
      XCTAssertFalse(undo.isEnabled)
      let before = XCTAttachment(screenshot: app.screenshot())
      before.name = "Before AUTO"
      before.lifetime = .keepAlways
      add(before)

      auto.click()
      let applied = XCTNSPredicateExpectation(
        predicate: NSPredicate(format: "enabled == true"), object: undo)
      XCTAssertEqual(XCTWaiter.wait(for: [applied], timeout: 60), .completed)
      let after = XCTAttachment(screenshot: app.screenshot())
      after.name = "After AUTO"
      after.lifetime = .keepAlways
      add(after)

      undo.click()
      let reverted = XCTNSPredicateExpectation(
        predicate: NSPredicate(format: "enabled == false"),
        object: undo)
      // Redo lives in More; Undo disables again when the original model is restored.
      XCTAssertEqual(XCTWaiter.wait(for: [reverted], timeout: 10), .completed)
    }
  }
#endif
