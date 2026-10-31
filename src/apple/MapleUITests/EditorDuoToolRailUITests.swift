// Duo editor tool reachability: the vertical control bar (open, landscape) or
// the phone controls with the side rail (closed) expose every tool.

import XCTest

#if os(iOS) && targetEnvironment(simulator)
  import UIKit

  final class EditorDuoToolRailUITests: XCTestCase {
    /// A compact width keeps the phone controls in either orientation, and they
    /// carry no rail tools or More (#4607), so the width decides the path.
    func testHealAndPresetsAreReachableInLandscape() throws {
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures")
        .appendingPathComponent("layout")
        .appendingPathComponent("rgb-gradient.png")
      let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-duo-more-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      try FileManager.default.copyItem(
        at: fixture, to: directory.appendingPathComponent(fixture.lastPathComponent))

      XCUIDevice.shared.orientation = .landscapeLeft
      defer { XCUIDevice.shared.orientation = .portrait }
      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = fixture.lastPathComponent
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = directory.path
      app.launchEnvironment["MAPLE_GPU_LIVE"] = "0"
      app.launch()
      defer { app.terminate() }

      let phoneControls = app.descendants(matching: .any)
        .matching(identifier: "editor-iphone-controls").firstMatch
      let toolDock = app.descendants(matching: .any)
        .matching(identifier: "editor-tool-dock").firstMatch
      let verticalBar = app.descendants(matching: .any)
        .matching(identifier: "editor-vertical-controls").firstMatch
      let either = XCTNSPredicateExpectation(
        predicate: NSPredicate { _, _ in
          phoneControls.exists || toolDock.exists || verticalBar.exists
        },
        object: nil)
      XCTAssertEqual(
        XCTWaiter.wait(for: [either], timeout: 10), .completed,
        "Editor shows no phone controls, tool dock, or vertical control bar")

      let openHeal: () -> Void
      let openPresets: () -> Void
      if toolDock.exists {
        let reveal = { (tool: XCUIElement, name: String) in
          XCTAssertTrue(tool.waitForExistence(timeout: 5), "Tool dock missing \(name)")
          for _ in 0..<4 where !tool.isHittable { toolDock.swipeUp() }
          XCTAssertTrue(tool.isHittable, "\(name) cannot be scrolled into reach")
          tool.tap()
        }
        openHeal = { reveal(app.buttons["editor-dock-tool-heal"], "Heal") }
        openPresets = { reveal(app.buttons["editor-dock-tool-presets"], "Presets") }
      } else if phoneControls.exists {
        guard UIDevice.current.name.localizedCaseInsensitiveContains("duo") else {
          throw XCTSkip("The Duo postures require an iPhone Duo simulator")
        }
        XCTAssertFalse(
          app.buttons["editor-dock-tool-heal"].exists,
          "The closed Duo keeps tools out of the toolbar")
        let detail = app.buttons["editor-dock-group-detail"]
        let strip = app.descendants(matching: .any)
          .matching(identifier: "editor-tool-row").firstMatch
        // The Detail strip overflows here; Heal and Presets may sit off-screen.
        let reveal = { (tool: XCUIElement, name: String) in
          detail.tap()
          XCTAssertTrue(tool.waitForExistence(timeout: 5), "Detail strip missing \(name)")
          let window = app.windows.firstMatch.frame
          for _ in 0..<4 where !window.contains(tool.frame) { strip.swipeLeft() }
          XCTAssertTrue(window.contains(tool.frame), "\(name) cannot be scrolled into reach")
          XCTAssertTrue(tool.isHittable, "\(name) is covered")
          tool.tap()
        }
        openHeal = { reveal(app.buttons["editor-tool-heal"], "Heal") }
        openPresets = { reveal(app.buttons["editor-tool-presets"], "Presets") }
      } else {
        let detail = app.buttons["editor-group-detail"]
        let column = app.descendants(matching: .any)
          .matching(identifier: "editor-tool-row").firstMatch
        let reveal = { (tool: XCUIElement, name: String) in
          detail.tap()
          XCTAssertTrue(tool.waitForExistence(timeout: 5), "Detail column missing \(name)")
          for _ in 0..<4 where !tool.isHittable { column.swipeUp() }
          XCTAssertTrue(tool.isHittable, "\(name) cannot be scrolled into reach")
          tool.tap()
        }
        openHeal = { reveal(app.buttons["editor-tool-heal"], "Heal") }
        openPresets = { reveal(app.buttons["editor-tool-presets"], "Presets") }
      }

      openHeal()
      XCTAssertTrue(
        app.descendants(matching: .any)
          .matching(identifier: "editor-retouch-panel").firstMatch.waitForExistence(timeout: 5))
      openPresets()
      XCTAssertTrue(
        app.descendants(matching: .any)
          .matching(identifier: "editor-presets-panel").firstMatch.waitForExistence(timeout: 5))
    }

    func testToolControlsMatchCurrentPhonePosture() throws {
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures/layout/rgb-gradient.png")
      let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-duo-rail-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      try FileManager.default.copyItem(
        at: fixture, to: directory.appendingPathComponent(fixture.lastPathComponent))

      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = fixture.lastPathComponent
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = directory.path
      app.launchEnvironment["MAPLE_GPU_LIVE"] = "0"
      app.launch()
      defer { app.terminate() }

      let light = app.buttons["editor-dock-group-light"]
      let compactControls = app.descendants(matching: .any)
        .matching(identifier: "editor-iphone-controls").firstMatch
      if compactControls.waitForExistence(timeout: 10) {
        guard UIDevice.current.name.localizedCaseInsensitiveContains("duo") else {
          throw XCTSkip("The closed side rail requires an iPhone Duo simulator")
        }
        XCTAssertTrue(light.exists, "Closed Duo group selectors should occupy the side rail")
        XCTAssertFalse(
          app.descendants(matching: .any)
            .matching(identifier: "editor-group-tabs").firstMatch.exists)
        XCTAssertFalse(app.buttons["editor-dock-tool-crop"].exists)
        for (group, firstTool) in [
          ("light", "exposure"), ("color", "temp"),
          ("effects", "clarity"), ("detail", "sharpen"),
        ] {
          let button = app.buttons["editor-dock-group-\(group)"]
          XCTAssertTrue(button.isHittable, "\(group) is hidden or clipped")
          button.tap()
          XCTAssertTrue(app.buttons["editor-tool-\(firstTool)"].waitForExistence(timeout: 5))
        }
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "Closed Duo editor group rail"
        attachment.lifetime = .keepAlways
        add(attachment)
        return
      }
      XCUIDevice.shared.orientation = .landscapeLeft
      defer { XCUIDevice.shared.orientation = .portrait }
      let verticalBar = app.descendants(matching: .any)
        .matching(identifier: "editor-vertical-controls").firstMatch
      guard verticalBar.waitForExistence(timeout: 10) else {
        throw XCTSkip("The open Duo posture requires an iPhone Duo simulator")
      }
      XCTAssertFalse(light.exists, "The open Duo shows no system tool rail")
      XCTAssertFalse(
        app.descendants(matching: .any)
          .matching(identifier: "editor-tool-dock").firstMatch.exists)

      let column = app.descendants(matching: .any)
        .matching(identifier: "editor-tool-row").firstMatch
      for (group, tools) in [
        ("light", ["exposure", "toneCurve"]), ("color", ["temp", "hsl"]),
        ("effects", ["clarity", "filmLook"]), ("detail", ["crop", "mask", "heal", "presets"]),
      ] {
        let button = app.buttons["editor-group-\(group)"]
        XCTAssertTrue(button.isHittable, "\(group) is hidden or clipped")
        button.tap()
        for tool in tools {
          let pill = app.buttons["editor-tool-\(tool)"]
          XCTAssertTrue(pill.waitForExistence(timeout: 5), "Missing \(tool) in \(group)")
          for _ in 0..<4 where !pill.isHittable { column.swipeUp() }
          XCTAssertTrue(pill.isHittable, "\(tool) cannot be scrolled into reach")
        }
      }

      app.buttons["editor-group-light"].tap()
      app.buttons["editor-tool-exposure"].tap()
      XCTAssertTrue(
        app.descendants(matching: .any)
          .matching(identifier: "editor-drag-bar").firstMatch.waitForExistence(timeout: 5))

      app.buttons["editor-tool-toneCurve"].tap()
      XCTAssertTrue(
        app.descendants(matching: .any)
          .matching(identifier: "editor-vertical-context-panel").firstMatch
          .waitForExistence(timeout: 5))
      XCTAssertFalse(
        app.descendants(matching: .any)
          .matching(identifier: "editor-drag-bar").firstMatch.exists)

      let attachment = XCTAttachment(screenshot: app.screenshot())
      attachment.name = "Open Duo vertical control bar"
      attachment.lifetime = .keepAlways
      add(attachment)
    }
  }
#endif
