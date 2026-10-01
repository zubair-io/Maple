import XCTest

#if os(macOS)
  /// Real editor controls + durable RAW/XMP companions. This qualifies history
  /// routing, not photographic reconstruction quality or device performance.
  final class RemovalHistoryUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    func testResetUndoRedoPersistTheAcceptedRemovalFromEditorControls() throws {
      let root = (0..<4).reduce(URL(fileURLWithPath: #filePath)) { url, _ in
        url.deletingLastPathComponent()
      }.appendingPathComponent("test-fixtures/removal/calibration")
      let staged = try StagedFixture.stage(
        raw: root.appendingPathComponent("source.dng"),
        sidecar: root.appendingPathComponent("saved.xmp"), label: "removal-history")
      defer { staged.remove() }
      let original = try Data(contentsOf: staged.raw)
      let recordsData = try Data(contentsOf: root.appendingPathComponent("records.txt"))
      let records = try XCTUnwrap(
        JSONSerialization.jsonObject(with: recordsData) as? [[String: Any]])
      let record = try XCTUnwrap(records.first)
      let accepted = try XCTUnwrap(record["accepted"] as? [String: Any])
      let mask = try XCTUnwrap(accepted["mask"] as? String)
      let patch = try XCTUnwrap(record["patch"] as? String)
      let companions = staged.directory.appendingPathComponent(".maple/inpaint")
      try FileManager.default.createDirectory(at: companions, withIntermediateDirectories: true)
      for (input, digest, suffix) in [("mask.mimf", mask, "mask"), ("patch.f16", patch, "f16")] {
        XCTAssertTrue(digest.hasPrefix("blake3:"))
        try FileManager.default.copyItem(
          at: root.appendingPathComponent(input),
          to: companions.appendingPathComponent("\(digest.dropFirst(7)).\(suffix)"))
      }

      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = staged.raw.lastPathComponent
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = staged.directory.path
      app.launchEnvironment["MAPLE_GPU_LIVE"] = "0"
      app.launch()
      defer {
        if let testRun, testRun.failureCount > 0 {
          let tree = XCTAttachment(string: app.debugDescription)
          tree.name = "Removal history accessibility tree"
          tree.lifetime = .keepAlways
          add(tree)
        }
        app.terminate()
      }
      XCTAssertTrue(app.otherElements["canvas-render-ready"].waitForExistence(timeout: 60))
      capture(app, name: "Saved removal before reset")
      let reset = app.buttons["editor-panel-reset-all"]
      XCTAssertTrue(reset.waitForExistence(timeout: 10))
      reset.click()
      assertRemoval(false, sidecar: staged.sidecar)
      app.typeKey("z", modifierFlags: .command)
      assertRemoval(true, sidecar: staged.sidecar)
      app.typeKey("z", modifierFlags: [.command, .shift])
      assertRemoval(false, sidecar: staged.sidecar)
      app.typeKey("z", modifierFlags: .command)
      assertRemoval(true, sidecar: staged.sidecar)
      capture(app, name: "Saved removal restored by keyboard undo")
      XCTAssertEqual(try Data(contentsOf: staged.raw), original)
      XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: companions.path).count, 2)
      XCTAssertFalse(app.staticTexts["editor-sidecar-save-error"].exists)
    }

    private func assertRemoval(
      _ present: Bool, sidecar: URL, file: StaticString = #filePath, line: UInt = #line
    ) {
      let expectation = XCTNSPredicateExpectation(
        predicate: NSPredicate { _, _ in
          guard let xml = try? String(contentsOf: sidecar, encoding: .utf8) else { return false }
          return xml.contains("papp:InpaintRemovals=") == present
        }, object: nil)
      XCTAssertEqual(
        XCTWaiter.wait(for: [expectation], timeout: 30), .completed, file: file, line: line)
    }

    private func capture(_ app: XCUIApplication, name: String) {
      let attachment = XCTAttachment(screenshot: app.screenshot())
      attachment.name = name
      attachment.lifetime = .keepAlways
      add(attachment)
    }
  }
#endif
