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
// window, which it records.
// `MAPLE_SCROLL_RUN_REUSE=1` keeps the folder and its thumbnails from the
// previous run, so "first" becomes the reopened-folder case. Paths may be
// absolute or relative to the app's home directory (its container on iOS).
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

  static let current: GridScrollRunRequest? = {
    let environment = ProcessInfo.processInfo.environment
    guard let seed = environment["MAPLE_SCROLL_RUN_SEED"], !seed.isEmpty,
      let count = environment["MAPLE_SCROLL_RUN_COUNT"].flatMap(Int.init)
    else { return nil }
    let report =
      environment["MAPLE_SCROLL_RUN_REPORT"].map(resolve)
      ?? FileManager.default.temporaryDirectory.appendingPathComponent("maple-scroll-run.json")
    return GridScrollRunRequest(
      seed: resolve(seed), count: count, report: report,
      reuse: environment["MAPLE_SCROLL_RUN_REUSE"] == "1")
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

  /// Returns `false` at once on a normal launch. A requested run never
  /// returns: it ends the process when the report is written.
  func runGridScrollMeasurementIfRequested() async -> Bool {
    guard let request = GridScrollRunRequest.current else { return false }
    hasRestoredInitialSource = true
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
    GridScrollEnvironment.bringToFront()
    let staged = try await Task.detached(priority: .userInitiated) {
      try ScrollRunFolder.stage(seed: request.seed, count: request.count, reuse: request.reuse)
    }.value
    report.reusedFolder = staged.reused
    loadFolder(url: staged.url)
    try await waitUntil("the folder listing published", timeout: .seconds(120)) {
      browseVM.assets.count >= request.count
    }
    var grid: GridScrollTarget?
    try await waitUntil("the grid became scrollable", timeout: .seconds(30)) {
      grid = GridScrollTarget.find()
      return grid != nil
    }
    guard let grid else { throw GridScrollRunFailure(reason: "no grid scroll view") }
    report.displayMaximumHz = grid.displayMaximumHz
    report.viewportWidth = grid.viewport.width
    report.viewportHeight = grid.viewport.height

    report.passes.append(await measuredPass("first", on: grid))
    let primeStart = CACurrentMediaTime()
    try await cacheEveryThumbnail(on: grid)
    report.primeSeconds = CACurrentMediaTime() - primeStart
    report.passes.append(await measuredPass("cached", on: grid))

    report.displayAwake = GridScrollEnvironment.displayAwake
    report.screenLocked = GridScrollEnvironment.screenLocked
    report.windowVisible = grid.windowVisible
  }

  private func measuredPass(_ name: String, on grid: GridScrollTarget) async -> ScrollPassReport {
    grid.offset = grid.minimumOffset
    let inFlight = await ThumbnailLoader.shared.inFlightLoadCount
    let start = grid.offset
    let frames = await GridScrollDriver(
      grid: grid, pointsPerSecond: Self.scrollRunPointsPerSecond
    ).scrollToBottom()
    return ScrollPassReport(
      name: name, frames: frames, distancePoints: grid.offset - start,
      thumbnailLoadsInFlightAtStart: inFlight)
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

/// The scroll view behind the Browse grid: the one with the most to scroll.
@MainActor
struct GridScrollTarget {
  #if os(macOS)
    let view: NSScrollView

    static func find() -> GridScrollTarget? {
      NSApp.windows
        .compactMap(\.contentView)
        .flatMap { descendants(of: $0) }
        .compactMap { $0 as? NSScrollView }
        .filter { $0.documentView?.isFlipped == true }
        .map(GridScrollTarget.init)
        .filter { $0.maximumOffset - $0.minimumOffset > $0.viewport.height }
        .max { $0.maximumOffset < $1.maximumOffset }
    }

    private static func descendants(of view: NSView) -> [NSView] {
      view.subviews.flatMap { [$0] + descendants(of: $0) }
    }

    var viewport: CGSize { view.contentView.bounds.size }
    var minimumOffset: Double { -view.contentInsets.top }
    var maximumOffset: Double {
      (view.documentView?.frame.maxY ?? 0) - viewport.height + view.contentInsets.bottom
    }
    var offset: Double {
      get { view.contentView.bounds.origin.y }
      nonmutating set {
        view.contentView.scroll(to: NSPoint(x: view.contentView.bounds.origin.x, y: newValue))
        view.reflectScrolledClipView(view.contentView)
      }
    }
    var displayMaximumHz: Int { view.window?.screen?.maximumFramesPerSecond ?? 0 }
    var windowVisible: Bool { view.window?.occlusionState.contains(.visible) ?? false }

    func makeDisplayLink(target: Any, selector: Selector) -> CADisplayLink {
      view.displayLink(target: target, selector: selector)
    }
  #else
    let view: UIScrollView

    static func find() -> GridScrollTarget? {
      UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .flatMap(\.windows)
        .flatMap { descendants(of: $0) }
        .compactMap { $0 as? UIScrollView }
        .map(GridScrollTarget.init)
        .filter { $0.maximumOffset - $0.minimumOffset > $0.viewport.height }
        .max { $0.maximumOffset < $1.maximumOffset }
    }

    private static func descendants(of view: UIView) -> [UIView] {
      view.subviews.flatMap { [$0] + descendants(of: $0) }
    }

    var viewport: CGSize { view.bounds.size }
    var minimumOffset: Double { -view.adjustedContentInset.top }
    var maximumOffset: Double {
      view.contentSize.height - viewport.height + view.adjustedContentInset.bottom
    }
    var offset: Double {
      get { view.contentOffset.y }
      nonmutating set {
        view.setContentOffset(CGPoint(x: view.contentOffset.x, y: newValue), animated: false)
      }
    }
    var displayMaximumHz: Int { view.window?.windowScene?.screen.maximumFramesPerSecond ?? 0 }
    var windowVisible: Bool {
      view.window?.isHidden == false && UIApplication.shared.applicationState == .active
    }

    func makeDisplayLink(target: Any, selector: Selector) -> CADisplayLink {
      let link = CADisplayLink(target: target, selector: selector)
      let maximum = Float(displayMaximumHz)
      // A scroll asks a ProMotion display for its full rate; so does this.
      if maximum > 60 {
        link.preferredFrameRateRange = CAFrameRateRange(
          minimum: 80, maximum: maximum, preferred: maximum)
      }
      return link
    }
  #endif
}

/// Moves the grid at a constant speed from display-link callbacks and records
/// each callback's refresh time, refresh period and commit time.
@MainActor
final class GridScrollDriver: NSObject {
  private let grid: GridScrollTarget
  private let pointsPerSecond: Double
  private var frames: [DisplayFrame] = []
  private var pending: (timestamp: Double, period: Double)?
  private var origin: (timestamp: Double, offset: Double)?
  private var reachedBottom = false
  private var link: CADisplayLink?
  private var commitObserver: CFRunLoopObserver?
  private var continuation: CheckedContinuation<[DisplayFrame], Never>?

  init(grid: GridScrollTarget, pointsPerSecond: Double) {
    self.grid = grid
    self.pointsPerSecond = pointsPerSecond
  }

  func scrollToBottom() async -> [DisplayFrame] {
    frames.reserveCapacity(16_384)
    return await withCheckedContinuation { continuation in
      self.continuation = continuation
      // Core Animation commits the frame from its own before-waiting
      // observer; running after it is how the commit's end is seen.
      let observer = CFRunLoopObserverCreateWithHandler(
        nil, CFRunLoopActivity.beforeWaiting.rawValue | CFRunLoopActivity.exit.rawValue, true,
        CFIndex.max
      ) { [weak self] _, _ in
        MainActor.assumeIsolated { self?.frameCommitted() }
      }
      CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
      commitObserver = observer
      let link = grid.makeDisplayLink(target: self, selector: #selector(tick(_:)))
      link.add(to: .main, forMode: .common)
      self.link = link
    }
  }

  @objc private func tick(_ link: CADisplayLink) {
    let period = link.targetTimestamp - link.timestamp
    pending = (link.timestamp, period > 0 ? period : link.duration)
    let origin = self.origin ?? (link.timestamp, grid.offset)
    self.origin = origin
    let wanted = origin.offset + (link.timestamp - origin.timestamp) * pointsPerSecond
    let bottom = grid.maximumOffset
    grid.offset = min(wanted, bottom)
    reachedBottom = wanted >= bottom
  }

  private func frameCommitted() {
    guard let pending else { return }
    self.pending = nil
    frames.append(
      DisplayFrame(
        timestamp: pending.timestamp, period: pending.period, committed: CACurrentMediaTime()))
    guard reachedBottom else { return }
    link?.invalidate()
    link = nil
    if let commitObserver {
      CFRunLoopRemoveObserver(CFRunLoopGetMain(), commitObserver, .commonModes)
    }
    commitObserver = nil
    continuation?.resume(returning: frames)
    continuation = nil
  }
}

@MainActor
enum GridScrollEnvironment {
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
    sysctlbyname(name, nil, &size, nil, 0)
    var value = [CChar](repeating: 0, count: size)
    sysctlbyname(name, &value, &size, nil, 0)
    return String(cString: value)
  }

  #if os(macOS)
    static func bringToFront() {
      NSApp.activate(ignoringOtherApps: true)
      guard let window = NSApp.windows.first(where: \.isVisible), let screen = window.screen
      else { return }
      window.setFrame(screen.visibleFrame, display: true)
      window.makeKeyAndOrderFront(nil)
    }

    static var displayAwake: Bool { CGDisplayIsAsleep(CGMainDisplayID()) == 0 }
    static var screenLocked: Bool {
      let session = CGSessionCopyCurrentDictionary() as? [String: Any]
      return session?["CGSSessionScreenIsLocked"] as? Bool ?? false
    }
  #else
    static func bringToFront() {}

    static var displayAwake: Bool { true }
    static var screenLocked: Bool { !UIApplication.shared.isProtectedDataAvailable }
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
