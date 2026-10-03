#if os(macOS)
  import Foundation
  import XCTest

  /// Large-window Browse with cold thumbnails. Stages real RAW bytes in a
  /// disposable directory; the photographer's library is never the cache target.
  final class BrowseScrollingPerformanceTests: XCTestCase {
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
