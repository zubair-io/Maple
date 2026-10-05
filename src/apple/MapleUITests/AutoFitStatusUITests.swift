import XCTest

#if os(macOS)
  /// The achieved outcome must remain visible through real profile changes (#4096).
  final class AutoFitStatusUITests: XCTestCase {
    func testActualAutoFitStatusInCpuAndGpuProfileControls() throws {
      continueAfterFailure = false
      for gpu in ["0", "1"] {
        for (name, expected) in [
          (
            "test_0006.DNG",
            "Color and contrast matched to this image’s embedded camera preview."
          ),
          (
            "test_0018.dng", "Auto matching is unavailable for this image; using Neutral rendering."
          ),
        ] {
          let source = try UITestFixtureRoot.locate(name)
          let original = try Data(contentsOf: source)
          let staged = FileManager.default.temporaryDirectory
            .appendingPathComponent("maple-auto-fit-ui-\(UUID().uuidString)", isDirectory: true)
          try FileManager.default.createDirectory(at: staged, withIntermediateDirectories: true)
          let copy = staged.appendingPathComponent(name)
          try FileManager.default.copyItem(at: source, to: copy)
          let products = (0..<4).reduce(Bundle(for: Self.self).bundleURL) { url, _ in
            url.deletingLastPathComponent()
          }
          let app = XCUIApplication(url: products.appendingPathComponent("Maple.app"))
          app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = name
          app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = staged.path
          app.launchEnvironment["MAPLE_GPU_LIVE"] = gpu
          app.launchEnvironment["MAPLE_GPU_HUD"] = "1"
          defer {
            if let testRun, testRun.failureCount > 0 {
              let tree = XCTAttachment(string: app.debugDescription)
              tree.name = "\(name) GPU=\(gpu) Auto-fit accessibility tree"
              tree.lifetime = .keepAlways
              add(tree)
            }
            app.terminate()
            try? FileManager.default.removeItem(at: staged)
          }
          app.launch()
          let color = app.buttons["editor-dock-group-color"]
          XCTAssertTrue(color.waitForExistence(timeout: 90))
          if !color.isSelected { color.click() }
          let status = app.descendants(matching: .any)
            .matching(identifier: "profile-auto-fit-status").firstMatch
          expect(status, label: expected)
          let hud = app.descendants(matching: .any)
            .matching(identifier: "gpu-frametime-hud").firstMatch
          if gpu == "1" {
            let presented = XCTNSPredicateExpectation(
              predicate: NSPredicate(
                format: "exists == 1 AND label BEGINSWITH 'GPU frame time. Last ' "
                  + "AND NOT label CONTAINS 'no data'"), object: hud)
            XCTAssertEqual(XCTWaiter.wait(for: [presented], timeout: 90), .completed)
          } else {
            XCTAssertFalse(hud.exists, "The CPU case must not publish GPU frame statistics")
          }
          attach(app, name: "\(name) GPU=\(gpu) achieved Auto")
          select(app, profile: "Neutral profile")
          expect(status, label: "Neutral uses a fixed base rendering.")
          attach(app, name: "\(name) GPU=\(gpu) selected Neutral")
          select(app, profile: "Auto profile")
          expect(status, label: expected)
          XCTAssertEqual(try Data(contentsOf: copy), original)
          XCTAssertEqual(try Data(contentsOf: source), original)
        }
      }
    }

    private func select(_ app: XCUIApplication, profile: String) {
      let choice = app.descendants(matching: .any)
        .matching(NSPredicate(format: "label == %@", profile)).firstMatch
      XCTAssertTrue(choice.waitForExistence(timeout: 10))
      XCTAssertTrue(choice.isHittable)
      choice.click()
    }

    private func expect(_ element: XCUIElement, label: String) {
      let match = XCTNSPredicateExpectation(
        predicate: NSPredicate(format: "exists == 1 AND value == %@", label), object: element)
      XCTAssertEqual(XCTWaiter.wait(for: [match], timeout: 90), .completed)
    }

    private func attach(_ app: XCUIApplication, name: String) {
      let screenshot = XCTAttachment(screenshot: app.screenshot())
      screenshot.name = name
      screenshot.lifetime = .keepAlways
      add(screenshot)
    }
  }
#endif
