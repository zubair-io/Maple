import XCTest

#if os(macOS)
  /// Real editor controls + durable RAW/XMP companions. This qualifies history
  /// routing, not photographic reconstruction quality or device performance.
  final class RemovalHistoryUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    func testKeyboardPaintingCancelsAndReplaysWholeStrokesWithoutPublishing() throws {
      let root = (0..<4).reduce(URL(fileURLWithPath: #filePath)) { url, _ in
        url.deletingLastPathComponent()
      }
      let raw = root.appendingPathComponent("test-fixtures/raws/removal-photographic/bologna.nef")
        .resolvingSymlinksInPath()
      guard FileManager.default.fileExists(atPath: raw.path) else {
        throw XCTSkip("Photographic keyboard workflow needs the Bologna RAW")
      }
      let staged = try StagedFixture.stage(
        raw: raw,
        sidecar: root.appendingPathComponent("test-fixtures/removal/calibration/prior.xmp"),
        label: "removal-keyboard")
      defer { staged.remove() }
      let original = try Data(contentsOf: staged.raw)
      let originalSidecar = try Data(contentsOf: staged.sidecar)
      let app = XCUIApplication()
      app.launchArguments = ["-editor.showsScope", "NO", "-editor.showsScopesPanel", "NO"]
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = ""
      app.launchEnvironment["MAPLE_GPU_LIVE"] = "1"
      app.launch()
      app.activate()
      // A restored frame from another display can leave inspector controls
      // off-screen. Use the standard window action before exercising input.
      app.menuBars.menuBarItems["Window"].click()
      try clickEnabled(app.menuItems["Fill"])
      defer {
        captureTree(app, name: "Keyboard painting final accessibility tree")
        capture(app, name: "Keyboard painting final photo")
        app.terminate()
      }
      try openFolderAndEditor(app, staged: staged)
      XCTAssertTrue(app.otherElements["canvas-render-ready"].waitForExistence(timeout: 60))
      let dock = app.scrollViews.matching(
        NSPredicate(format: "identifier == %@ AND label == %@", "editor-tool-dock", "Editor tools")
      ).firstMatch
      XCTAssertTrue(dock.waitForExistence(timeout: 10))
      try revealRemoveTool(in: dock, app: app)
      try clickEnabled(app.buttons["editor-dock-tool-remove"])
      let clear = app.buttons["Clear selection"]
      XCTAssertTrue(clear.waitForExistence(timeout: 60))
      XCTAssertTrue(app.buttons["removal-mode-paint"].exists)
      XCTAssertTrue(app.buttons["removal-mode-smart"].exists)
      XCTAssertTrue(app.buttons["removal-mode-people"].exists)
      XCTAssertFalse(clear.isEnabled)
      let canvas = app.buttons["removal-paint-canvas"]
      XCTAssertTrue(canvas.waitForExistence(timeout: 10))
      canvas.click()
      try waitForEnabled(clear, true)
      app.typeKey("z", modifierFlags: .command)
      try waitForEnabled(clear, false)
      XCTAssertTrue((canvas.value as? String)?.hasPrefix("Brush ") == true)
      capture(app, name: "Keyboard brush before painting")
      app.typeKey(" ", modifierFlags: [])
      XCTAssertTrue((canvas.value as? String)?.contains("stroke active") == true)
      app.typeKey(.rightArrow, modifierFlags: .shift)
      app.typeKey(.escape, modifierFlags: [])
      XCTAssertTrue(clear.exists, "Escape left the removal tool instead of canceling the stroke")
      XCTAssertFalse(clear.isEnabled)
      app.typeKey(" ", modifierFlags: [])
      XCTAssertTrue(
        (canvas.value as? String)?.contains("stroke active") == true,
        "The brush did not receive the next keyboard stroke")
      app.typeKey(.rightArrow, modifierFlags: .shift)
      app.typeKey(.downArrow, modifierFlags: .shift)
      app.typeKey(" ", modifierFlags: [])
      try waitForEnabled(clear, true)
      XCTAssertTrue(clear.isEnabled)
      capture(app, name: "Keyboard whole stroke selected")
      app.typeKey("z", modifierFlags: .command)
      try waitForEnabled(clear, false)
      app.typeKey("z", modifierFlags: [.command, .shift])
      try waitForEnabled(clear, true)
      XCTAssertEqual(try Data(contentsOf: staged.raw), original)
      XCTAssertEqual(try Data(contentsOf: staged.sidecar), originalSidecar)
      XCTAssertFalse(
        FileManager.default.fileExists(
          atPath: staged.directory.appendingPathComponent(".maple/inpaint").path))
      XCTAssertFalse(app.staticTexts["editor-sidecar-save-error"].exists)
    }

    private func waitForEnabled(_ element: XCUIElement, _ value: Bool) throws {
      let expectation = XCTNSPredicateExpectation(
        predicate: NSPredicate(format: "enabled == %@", NSNumber(value: value)), object: element)
      _ = try XCTUnwrap(
        XCTWaiter.wait(for: [expectation], timeout: 30) == .completed ? true : nil,
        element.description)
    }

    private func revealRemoveTool(in dock: XCUIElement, app: XCUIApplication) throws {
      let remove = app.buttons["editor-dock-tool-remove"]
      for _ in 0..<8 where remove.frame.maxY > dock.frame.maxY {
        dock.swipeUp()
      }
      XCTAssertLessThanOrEqual(
        remove.frame.maxY, dock.frame.maxY,
        "Remove tool stayed outside the dock viewport at \(remove.frame) in \(dock.frame)")
    }

    func testResetUndoRedoPersistTheAcceptedRemovalFromEditorControls() throws {
      let staged = try stageSavedRemoval()
      defer { staged.remove() }
      let original = try Data(contentsOf: staged.raw)
      let originalCompanions = try companionBytes(staged)

      let app = XCUIApplication()
      app.launchArguments = ["-editor.showsScope", "NO", "-editor.showsScopesPanel", "NO"]
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = ""
      app.launchEnvironment["MAPLE_GPU_LIVE"] = "0"
      app.launch()
      app.activate()
      defer {
        captureTree(app, name: "Removal history accessibility tree")
        captureSidecar(staged.sidecar)
        app.terminate()
      }
      try openFolderAndEditor(app, staged: staged)
      _ = try XCTUnwrap(
        app.otherElements["canvas-render-ready"].waitForExistence(timeout: 60) ? true : nil)
      capture(app, name: "Saved removal before reset")
      let reset = app.buttons["editor-panel-reset-all"]
      XCTAssertTrue(reset.waitForExistence(timeout: 10))
      reset.click()
      try assertRemoval(false, sidecar: staged.sidecar)
      app.typeKey("z", modifierFlags: .command)
      try assertRemoval(true, sidecar: staged.sidecar)
      app.typeKey("z", modifierFlags: [.command, .shift])
      try assertRemoval(false, sidecar: staged.sidecar)
      app.typeKey("z", modifierFlags: .command)
      try assertRemoval(true, sidecar: staged.sidecar)
      capture(app, name: "Saved removal restored by keyboard undo")
      XCTAssertEqual(try Data(contentsOf: staged.raw), original)
      XCTAssertEqual(try companionBytes(staged), originalCompanions)
      XCTAssertFalse(app.staticTexts["editor-sidecar-save-error"].exists)
    }

    func testSavedControlsPersistAndReopenWithoutModelsAndCancelReplacementWritesNothing() throws {
      let staged = try stageSavedRemoval()
      defer { staged.remove() }
      let original = try Data(contentsOf: staged.raw)
      let originalCompanions = try companionBytes(staged)
      let app = XCUIApplication()
      app.launchArguments = ["-editor.showsScope", "NO", "-editor.showsScopesPanel", "NO"]
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = ""
      app.launchEnvironment["MAPLE_GPU_LIVE"] = "1"
      app.launch()
      app.activate()
      defer {
        captureTree(app, name: "Saved removal accessibility tree")
        captureSidecar(staged.sidecar)
        capture(app, name: "Saved removal final state")
        app.terminate()
      }
      try openFolderAndEditor(app, staged: staged)
      try openSavedControls(app)
      capture(app, name: "Saved removal enabled")
      try clickEnabled(app.buttons["Disable removal 1"])
      try waitForRecord(sidecar: staged.sidecar, active: false)
      let disabled = try savedRecord(sidecar: staged.sidecar)
      let id = try XCTUnwrap(disabled?["id"] as? String)
      XCTAssertEqual(disabled?["schema"] as? Int, 5)
      try clickEnabled(app.buttons["Enable removal 1"])
      try waitForRecord(sidecar: staged.sidecar, active: true)
      XCTAssertEqual(try savedRecord(sidecar: staged.sidecar)?["id"] as? String, id)
      try clickEnabled(app.buttons["Replace removal 1"])
      try clickEnabled(app.buttons["Cancel replacement"])
      let before = try Data(contentsOf: staged.sidecar)
      try clickEnabled(app.buttons["Replace removal 1"])
      XCTAssertTrue(app.buttons["Cancel replacement"].waitForExistence(timeout: 30))
      XCTAssertTrue(app.buttons["Clear selection"].isEnabled)
      XCTAssertEqual(try Data(contentsOf: staged.sidecar), before)
      capture(app, name: "Saved mask loaded for replacement")
      try clickEnabled(app.buttons["Cancel replacement"])
      XCTAssertEqual(try Data(contentsOf: staged.sidecar), before)
      try clickEnabled(app.buttons["Delete removal 1"])
      try waitForRecord(sidecar: staged.sidecar, active: nil)
      app.typeKey("z", modifierFlags: .command)
      try waitForRecord(sidecar: staged.sidecar, active: true)
      XCTAssertEqual(try savedRecord(sidecar: staged.sidecar)?["id"] as? String, id)
      app.typeKey("z", modifierFlags: [.command, .shift])
      try waitForRecord(sidecar: staged.sidecar, active: nil)
      app.typeKey("z", modifierFlags: .command)
      try waitForRecord(sidecar: staged.sidecar, active: true)
      app.terminate()
      app.launch()
      app.activate()
      try openFolderAndEditor(app, staged: staged)
      try openSavedControls(app)
      XCTAssertTrue(app.buttons["Disable removal 1"].waitForExistence(timeout: 30))
      capture(app, name: "Saved removal reopened without inference")
      XCTAssertEqual(try savedRecord(sidecar: staged.sidecar)?["id"] as? String, id)
      XCTAssertEqual(try Data(contentsOf: staged.raw), original)
      XCTAssertEqual(try companionBytes(staged), originalCompanions)
      XCTAssertFalse(app.staticTexts["editor-sidecar-save-error"].exists)
    }

    private func openSavedControls(_ app: XCUIApplication) throws {
      _ = try XCTUnwrap(
        app.otherElements["canvas-render-ready"].waitForExistence(timeout: 60) ? true : nil)
      let dock = app.scrollViews.matching(
        NSPredicate(format: "identifier == %@ AND label == %@", "editor-tool-dock", "Editor tools")
      ).firstMatch
      _ = try XCTUnwrap(dock.waitForExistence(timeout: 10) ? true : nil)
      try revealRemoveTool(in: dock, app: app)
      try clickEnabled(app.buttons["editor-dock-tool-remove"])
      _ = try XCTUnwrap(app.buttons["Clear selection"].waitForExistence(timeout: 60) ? true : nil)
      captureTree(app, name: "Removal controls before saved expansion")
      capture(app, name: "Removal controls before saved expansion")
      try clickEnabled(app.buttons["Saved removals"])
    }

    /// Exercise the production picker grant: Xcode's fixture read exception
    /// does not grant writes to the runner's temporary folder or XMP lock.
    private func openFolderAndEditor(_ app: XCUIApplication, staged: StagedFixture) throws {
      app.typeKey("o", modifierFlags: .command)
      _ = try XCTUnwrap(app.sheets["open-panel"].waitForExistence(timeout: 30) ? true : nil)
      app.typeKey("g", modifierFlags: [.command, .shift])
      let path = app.textFields["PathTextField"]
      _ = try XCTUnwrap(path.waitForExistence(timeout: 10) ? true : nil)
      path.click()
      app.typeKey("a", modifierFlags: .command)
      path.typeText(staged.directory.path)
      app.typeKey(.return, modifierFlags: [])
      if app.sheets["GoToWindow"].exists { app.typeKey(.return, modifierFlags: []) }
      _ = try XCTUnwrap(app.sheets["GoToWindow"].waitForNonExistence(timeout: 10) ? true : nil)
      try clickEnabled(app.buttons["OKButton"])
      let name = staged.raw.deletingPathExtension().lastPathComponent
      let photo = app.descendants(matching: .any)["thumb-\(name)"]
      _ = try XCTUnwrap(photo.waitForExistence(timeout: 30) ? true : nil)
      photo.click()
      try clickEnabled(app.buttons["preview-edit"])
    }

    private func captureTree(_ app: XCUIApplication, name: String) {
      let tree = XCTAttachment(string: app.debugDescription)
      tree.name = name
      tree.lifetime = .keepAlways
      add(tree)
    }

    private func captureSidecar(_ sidecar: URL) {
      guard let xml = try? String(contentsOf: sidecar, encoding: .utf8) else { return }
      let attachment = XCTAttachment(string: xml)
      attachment.name = "Actual saved XMP"
      attachment.lifetime = .keepAlways
      add(attachment)
    }

    private func clickEnabled(_ element: XCUIElement) throws {
      _ = try XCTUnwrap(element.waitForExistence(timeout: 30) ? true : nil, element.description)
      let enabled = XCTNSPredicateExpectation(
        predicate: NSPredicate(format: "enabled == true"), object: element)
      _ = try XCTUnwrap(
        XCTWaiter.wait(for: [enabled], timeout: 30) == .completed ? true : nil, element.description)
      element.click()
    }

    private func companionBytes(_ staged: StagedFixture) throws -> [String: Data] {
      let directory = staged.directory.appendingPathComponent(".maple/inpaint")
      let files = try FileManager.default.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: nil)
      XCTAssertEqual(files.count, 2)
      return try Dictionary(
        uniqueKeysWithValues: files.map { url in
          (url.lastPathComponent, try Data(contentsOf: url))
        })
    }

    private func savedRecord(sidecar: URL) throws -> [String: Any]? {
      let document = try XMLDocument(contentsOf: sidecar)
      let attribute = try document.nodes(forXPath: "//@*[local-name()='InpaintRemovals']").first
      guard let text = attribute?.stringValue else { return nil }
      let records = try XCTUnwrap(
        JSONSerialization.jsonObject(with: Data(text.utf8)) as? [[String: Any]])
      return records.first
    }

    private func waitForRecord(sidecar: URL, active: Bool?) throws {
      let saved = XCTNSPredicateExpectation(
        predicate: NSPredicate { _, _ in
          do {
            let record = try self.savedRecord(sidecar: sidecar)
            guard let record else { return active == nil }
            return record["active"] as? Bool == active
          } catch { return false }
        }, object: nil)
      _ = try XCTUnwrap(
        XCTWaiter.wait(for: [saved], timeout: 30) == .completed ? true : nil,
        "Saved removal XMP did not reach expected state")
    }

    private func stageSavedRemoval() throws -> StagedFixture {
      let root = (0..<4).reduce(URL(fileURLWithPath: #filePath)) { url, _ in
        url.deletingLastPathComponent()
      }.appendingPathComponent("test-fixtures/removal/calibration")
      let staged = try StagedFixture.stage(
        raw: root.appendingPathComponent("source.dng"),
        sidecar: root.appendingPathComponent("saved.xmp"), label: "removal-history")
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

      return staged
    }

    private func assertRemoval(
      _ present: Bool, sidecar: URL, file: StaticString = #filePath, line: UInt = #line
    ) throws {
      let expectation = XCTNSPredicateExpectation(
        predicate: NSPredicate { _, _ in
          guard let xml = try? String(contentsOf: sidecar, encoding: .utf8) else { return false }
          return xml.contains("papp:InpaintRemovals=") == present
        }, object: nil)
      _ = try XCTUnwrap(
        XCTWaiter.wait(for: [expectation], timeout: 30) == .completed ? true : nil,
        "Saved removal XMP did not reach expected state", file: file, line: line)
    }

    private func capture(_ app: XCUIApplication, name: String) {
      let attachment = XCTAttachment(screenshot: app.screenshot())
      attachment.name = name
      attachment.lifetime = .keepAlways
      add(attachment)
    }
  }
#endif
