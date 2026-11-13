#if os(macOS)
  import Foundation
  import XCTest

  /// Large-window Browse with cold thumbnails. Stages real RAW bytes in a
  /// disposable directory; the photographer's library is never the cache target.
  final class BrowseScrollingPerformanceTests: XCTestCase {
    func testPreviewBackRevealsThePhotoOpenedBelowTheFold() throws {
      continueAfterFailure = false
      let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("Fixtures/layout/rgb-gradient.png")
      let folder = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-preview-return-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: folder) }

      let first = folder.appendingPathComponent("sample-00.png")
      try FileManager.default.copyItem(at: fixture, to: first)
      for index in 1..<40 {
        try FileManager.default.linkItem(
          at: first, to: folder.appendingPathComponent(String(format: "sample-%02d.png", index)))
      }

      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = first.lastPathComponent
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = folder.path
      app.launchArguments = ["--uitest-browse"]
      app.launch()
      defer { app.terminate() }

      let firstCell = app.buttons["thumb-sample-00"]
      XCTAssertTrue(firstCell.waitForExistence(timeout: 20))
      let lastCell = app.buttons["thumb-sample-39"]
      let scroll = app.scrollViews["browse-scroll"]
      XCTAssertTrue(scroll.exists)
      for _ in 0..<12 where !lastCell.isHittable {
        scroll.scroll(byDeltaX: 0, deltaY: -600)
      }
      XCTAssertTrue(lastCell.isHittable, "The last tile must be reachable below the fold")
      XCTAssertFalse(firstCell.isHittable, "The grid must be scrolled away from its first row")

      lastCell.doubleClick()
      XCTAssertTrue(app.staticTexts["preview-filename"].waitForExistence(timeout: 10))
      XCTAssertEqual(app.staticTexts["preview-filename"].label, "sample-39")
      app.buttons["preview-back"].click()
      XCTAssertTrue(scroll.waitForExistence(timeout: 10))
      XCTAssertTrue(
        lastCell.waitForExistence(timeout: 10) && lastCell.isHittable,
        "Preview Back must bring the current tile back into the Browse viewport")
      attachReturnScreenshot(app)
    }

    private func attachReturnScreenshot(_ app: XCUIApplication) {
      let attachment = XCTAttachment(screenshot: app.screenshot())
      attachment.name = "Browse after Preview Back"
      attachment.lifetime = .keepAlways
      add(attachment)
    }

    func testCold500ImageFolderScrollsWhileThumbnailsLoad() throws {
      let fixture = try UITestFixtureRoot.locate("test_0017.dng")
      let folder = FileManager.default.temporaryDirectory
        .appendingPathComponent("maple-browse-perf-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: folder) }
      // One copied original plus hard links keep the real 500-file browse workload
      // without copying 500 large RAWs or modifying the fixture's original inode.
      let first = folder.appendingPathComponent("image-0000.dng")
      try FileManager.default.copyItem(at: fixture, to: first)
      for index in 1..<500 {
        try FileManager.default.linkItem(
          at: first, to: folder.appendingPathComponent(String(format: "image-%04d.dng", index)))
      }
      let app = XCUIApplication()
      app.launchEnvironment["MAPLE_UITEST_FIXTURE"] = first.lastPathComponent
      app.launchEnvironment["MAPLE_UITEST_FIXTURE_ROOT"] = folder.path
      app.launchArguments = ["--uitest-browse"]
      app.launch()
      defer { app.terminate() }
      let firstCell = app.descendants(matching: .any)["thumb-image-0000"].firstMatch
      XCTAssertTrue(firstCell.waitForExistence(timeout: 20), "Cold Browse never became interactive")
      app.activate()
      // Send the shortcut to the actual window: an application's synthetic
      // event target can have an infinite frame on a multi-display desktop.
      let window = app.windows.firstMatch
      XCTAssertTrue(window.waitForExistence(timeout: 10))
      window.typeKey("f", modifierFlags: [.control, .command])
      let before = XCTAttachment(screenshot: app.screenshot())
      before.name = "Cold 500-image Browse"
      before.lifetime = .keepAlways
      add(before)

      let scroll = app.scrollViews["browse-scroll"]
      XCTAssertTrue(scroll.exists)
      let options = XCTMeasureOptions()
      options.iterationCount = 1
      measure(
        metrics: [
          XCTOSSignpostMetric.scrollingAndDecelerationMetric,
          XCTCPUMetric(application: app), XCTMemoryMetric(application: app),
        ],
        options: options
      ) {
        for _ in 0..<12 {
          scroll.scroll(byDeltaX: 0, deltaY: -600)
        }
        let lastCell = app.descendants(matching: .any)["thumb-image-0499"].firstMatch
        XCTAssertTrue(lastCell.isHittable, "Scrolling never reached the last image")
        for _ in 0..<12 {
          scroll.scroll(byDeltaX: 0, deltaY: 600)
        }
      }
      XCTAssertTrue(firstCell.isHittable, "Browse failed to scroll back to its first image")
      let after = XCTAttachment(screenshot: app.screenshot())
      after.name = "Browse after scrolling during thumbnail loading"
      after.lifetime = .keepAlways
      add(after)
    }
  }
#endif
