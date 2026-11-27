// AppShell+GridScrollRun.swift — measures dropped frames while the Browse grid
// scrolls, with no UI automation (#6048).
//
// Launching with `MAPLE_SCROLL_RUN_SEED` (a folder of sample photos) and
// `MAPLE_SCROLL_RUN_COUNT` replaces the normal last-folder restore with one
// measurement and then quits:
//
//   1. clone the seed into a throwaway folder of COUNT photos and open it in
//      Browse through the production folder path;
//   2. as soon as the grid is published, scroll top to bottom at a fixed speed
//      while thumbnails are still loading (pass "first");
//   3. walk the grid a screen at a time until every thumbnail is cached, then
//      scroll top to bottom again (pass "cached");
//   4. write one JSON report to `MAPLE_SCROLL_RUN_REPORT` and the log.
//
// The grid's own scroll view is moved from a display-link callback, the way a
// real scroll moves it, and the same callbacks are the frame record: what the
// display link delivered, and when each frame's layout and commit finished.
// A report only counts if the display was awake, unlocked and showing the
// window throughout every pass, which it records as `framesVisible`.
// `MAPLE_SCROLL_RUN_REUSE=1` keeps the folder and its thumbnails from the
// previous run, so "first" becomes the reopened-folder case. Paths are
// absolute, or relative to the app's home directory (its container on iOS).
// `src/scripts/measure_grid_scroll.sh` drives all of it.

import MapleCore
import QuartzCore
import SwiftUI
import os

#if os(macOS)
  import AppKit
#else
  import UIKit
#endif

private let scrollRunLog = Logger(subsystem: "app.justmaple.aperture", category: "scrollrun")

struct GridScrollRunRequest {
  let seed: URL
  let count: Int
  let report: URL
  let reuse: Bool

  /// A count that does not parse is kept as zero so the run fails with a
  /// report instead of turning into a normal launch that never quits.
  static let current: GridScrollRunRequest? = {
    let environment = ProcessInfo.processInfo.environment
    guard let seed = environment["MAPLE_SCROLL_RUN_SEED"], !seed.isEmpty else { return nil }
    let report =
      environment["MAPLE_SCROLL_RUN_REPORT"].flatMap { $0.isEmpty ? nil : resolve($0) }
      ?? FileManager.default.temporaryDirectory.appendingPathComponent("maple-scroll-run.json")
    return GridScrollRunRequest(
      seed: resolve(seed),
      count: environment["MAPLE_SCROLL_RUN_COUNT"].flatMap(Int.init) ?? 0,
      report: report, reuse: environment["MAPLE_SCROLL_RUN_REUSE"] == "1")
  }()

  private static func resolve(_ path: String) -> URL {
    path.hasPrefix("/")
      ? URL(fileURLWithPath: path)
      : URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(path)
  }
}

private struct GridScrollRunFailure: Error {
  let reason: String
}

@MainActor
extension AppShell {
  static let scrollRunPointsPerSecond = 3000.0

  /// `false` on a normal launch. In a requested run the first window measures
  /// and ends the process; any other window stays empty, because a restored
  /// folder there would load thumbnails into the measurement.
  func runGridScrollMeasurementIfRequested() async -> Bool {
    guard let request = GridScrollRunRequest.current else { return false }
    hasRestoredInitialSource = true
    guard GridScrollEnvironment.claimRun() else { return true }
    var report = ScrollRunReport()
    report.photoCount = request.count
    report.device = GridScrollEnvironment.device
    report.system = ProcessInfo.processInfo.operatingSystemVersionString
    report.build = "\(BuildProvenance.gitSHA) \(GridScrollEnvironment.configuration)"
    report.loadAverageAtStart = GridScrollEnvironment.loadAverage
    do {
      try await measureGridScroll(request, into: &report)
    } catch let failure as GridScrollRunFailure {
      report.error = failure.reason
    } catch {
      report.error = String(describing: error)
    }
    report.loadAverageAtEnd = GridScrollEnvironment.loadAverage
    report.thermalState = GridScrollEnvironment.thermalState
    report.lowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
    GridScrollEnvironment.finish(report, at: request.report)
  }

  private func measureGridScroll(
    _ request: GridScrollRunRequest, into report: inout ScrollRunReport
  ) async throws {
    #if os(macOS)
      try await waitUntil("the window was on the primary display", timeout: .seconds(20)) {
        GridScrollEnvironment.fillPrimaryScreen()
      }
    #else
      // An untouched iPad would dim and lock partway through a long run.
      UIApplication.shared.isIdleTimerDisabled = true
    #endif
    let staged = try await Task.detached(priority: .userInitiated) {
      try ScrollRunFolder.stage(seed: request.seed, count: request.count, reuse: request.reuse)
    }.value
    report.reusedFolder = staged.reused
    browseVM.gridFilter = .all
    loadFolder(url: staged.url)
    try await waitUntil("the folder listing published", timeout: .seconds(120)) {
      browseVM.assets.count >= request.count
    }
    var found: GridScrollTarget?
    try await waitUntil("the grid became scrollable", timeout: .seconds(30)) {
      found = GridScrollTarget.find()
      return found != nil
    }
    guard let grid = found else { throw GridScrollRunFailure(reason: "no grid scroll view") }
    report.displayMaximumHz = grid.displayMaximumHz
    report.viewportWidth = grid.viewport.width
    report.viewportHeight = grid.viewport.height

    try await measurePass("first", on: grid, into: &report)
    let primeStart = CACurrentMediaTime()
    try await cacheEveryThumbnail(on: grid)
    report.primeSeconds = CACurrentMediaTime() - primeStart
    report.cachedThumbnails = ScrollRunFolder.cachedThumbnailCount(in: staged.url)
    try await measurePass("cached", on: grid, into: &report)
  }

  private func measurePass(
    _ name: String, on grid: GridScrollTarget, into report: inout ScrollRunReport
  ) async throws {
    grid.offset = grid.minimumOffset
    let inFlight = await ThumbnailLoader.shared.inFlightLoadCount
    let start = grid.offset
    let visibleBefore = grid.framesVisible
    let expectedSeconds = (grid.maximumOffset - start) / Self.scrollRunPointsPerSecond
    let pass = await GridScrollDriver(grid: grid, pointsPerSecond: Self.scrollRunPointsPerSecond)
      .scrollToBottom(givingUpAfter: .seconds(60 + 4 * expectedSeconds))
    report.framesVisible =
      (report.framesVisible ?? true) && visibleBefore && pass.stayedVisible && grid.framesVisible
    report.passes.append(
      ScrollPassReport(
        name: name, frames: pass.frames, distancePoints: grid.offset - start,
        thumbnailLoadsInFlightAtStart: inFlight))
    guard pass.reachedBottom else {
      throw GridScrollRunFailure(
        reason: "pass \(name) stopped before the bottom: the display link stopped calling back")
    }
  }

  private func cacheEveryThumbnail(on grid: GridScrollTarget) async throws {
    grid.offset = grid.minimumOffset
    try await waitForThumbnailLoads()
    while grid.offset < grid.maximumOffset - 1 {
      grid.offset = min(grid.offset + grid.viewport.height * 0.9, grid.maximumOffset)
      try await waitForThumbnailLoads()
    }
    grid.offset = grid.minimumOffset
    try await waitForThumbnailLoads()
  }

  private func waitForThumbnailLoads() async throws {
    var quietPolls = 0
    try await waitUntil("thumbnail loads settled", timeout: .seconds(300)) {
      quietPolls = await ThumbnailLoader.shared.inFlightLoadCount == 0 ? quietPolls + 1 : 0
      return quietPolls >= 8
    }
  }

  private func waitUntil(
    _ what: String, timeout: Duration, _ condition: @MainActor () async -> Bool
  ) async throws {
    let deadline = ContinuousClock.now + timeout
    while !(await condition()) {
      guard ContinuousClock.now < deadline else {
        throw GridScrollRunFailure(reason: "timed out before \(what)")
      }
      try await Task.sleep(for: .milliseconds(50))
    }
  }
}

@MainActor
enum GridScrollEnvironment {
  private static var runClaimed = false

  static func claimRun() -> Bool {
    guard !runClaimed else { return false }
    runClaimed = true
    return true
  }

  static var configuration: String {
    #if DEBUG
      "Debug"
    #else
      "Release"
    #endif
  }

  static var loadAverage: Double {
    var loads = [0.0]
    return getloadavg(&loads, 1) == 1 ? loads[0] : 0
  }

  static var thermalState: String {
    switch ProcessInfo.processInfo.thermalState {
    case .nominal: "nominal"
    case .fair: "fair"
    case .serious: "serious"
    case .critical: "critical"
    @unknown default: "unknown"
    }
  }

  static var device: String {
    #if os(macOS)
      let name = "hw.model"
    #else
      let name = "hw.machine"
    #endif
    var size = 0
    guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return "" }
    var value = [UInt8](repeating: 0, count: size)
    guard sysctlbyname(name, &value, &size, nil, 0) == 0 else { return "" }
    return String(decoding: value.prefix { $0 != 0 }, as: UTF8.self)
  }

  #if os(macOS)
    /// Every run is measured full-size on the primary display; a window that
    /// opened elsewhere (a second or virtual display runs at its own rate and
    /// size) is moved there. False until the window is up and has arrived.
    static func fillPrimaryScreen() -> Bool {
      NSApp.activate(ignoringOtherApps: true)
      guard let window = NSApp.windows.first(where: \.isVisible),
        let screen = NSScreen.screens.first
      else { return false }
      window.setFrame(screen.visibleFrame, display: true)
      window.makeKeyAndOrderFront(nil)
      return window.screen == screen
    }
  #endif

  static func finish(_ report: ScrollRunReport, at url: URL) -> Never {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let written: Bool
    do {
      try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try encoder.encode(report).write(to: url, options: .atomic)
      written = true
    } catch {
      let reason = String(describing: error)
      scrollRunLog.error("scroll run report not written: \(reason, privacy: .public)")
      written = false
    }
    for pass in report.passes {
      let stats = pass.stats
      let line =
        "scroll run \(pass.name): presented=\(stats.framesPresented) dropped=\(stats.framesDropped)"
        + " longestStallMs=\(Int(stats.longestStallMs.rounded()))"
        + " stallMsPerSecond=\((stats.stallMsPerSecond * 10).rounded() / 10)"
        + " hz=\(Int(stats.refreshHz.rounded())) seconds=\((stats.scrollSeconds * 10).rounded() / 10)"
      scrollRunLog.notice("\(line, privacy: .public)")
      print(line)
    }
    if let error = report.error {
      scrollRunLog.error("scroll run failed: \(error, privacy: .public)")
      print("scroll run failed: \(error)")
    }
    exit(report.error == nil && written ? 0 : 1)
  }
}
