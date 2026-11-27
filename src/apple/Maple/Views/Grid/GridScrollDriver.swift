// GridScrollDriver.swift — moves the Browse grid's own scroll view at a fixed
// speed and records the frames, for the scroll measurement (#6048; see
// AppShell+GridScrollRun.swift).

import MapleCore
import QuartzCore
import SwiftUI

#if os(macOS)
  import AppKit
#else
  import UIKit
#endif

/// The scroll view behind the Browse grid. On a Mac and an iPad the grid is the
/// widest pane, so it is the widest vertically scrollable view; a long sidebar
/// or inspector is taller on some libraries but never wider. Where panes are
/// equally wide, the one with the most to scroll is the 500-photo grid.
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
        .max { $0.rank < $1.rank }
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
    var framesVisible: Bool {
      let session = CGSessionCopyCurrentDictionary() as? [String: Any]
      let locked = session?["CGSSessionScreenIsLocked"] as? Bool ?? false
      return CGDisplayIsAsleep(CGMainDisplayID()) == 0 && !locked
        && view.window?.occlusionState.contains(.visible) == true
    }

    func makeDisplayLink(target: Any, selector: Selector) -> CADisplayLink {
      view.displayLink(target: target, selector: selector)
    }

    /// Calls `lost` whenever the window may have stopped being shown. While
    /// it is hidden the display link is silent, so checking at the ends of a
    /// pass misses a lock or minimise that is over before the pass is.
    func watchVisibility(_ lost: @escaping @MainActor @Sendable () -> Void) -> () -> Void {
      let local = NotificationCenter.default
      let workspace = NSWorkspace.shared.notificationCenter
      let distributed = DistributedNotificationCenter.default()
      let watched: [(NotificationCenter, Notification.Name, Any?)] = [
        (local, NSWindow.didChangeOcclusionStateNotification, view.window),
        (workspace, NSWorkspace.screensDidSleepNotification, nil),
        (distributed, Notification.Name("com.apple.screenIsLocked"), nil),
      ]
      let tokens = watched.map { center, name, object in
        (
          center,
          center.addObserver(forName: name, object: object, queue: .main) { _ in
            MainActor.assumeIsolated { lost() }
          }
        )
      }
      return { tokens.forEach { center, token in center.removeObserver(token) } }
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
        .max { $0.rank < $1.rank }
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
    // iOS takes an app out of the active state before the display sleeps or
    // the device locks, so active and on screen means the frames were shown.
    var framesVisible: Bool {
      view.window?.isHidden == false && UIApplication.shared.applicationState == .active
    }

    func makeDisplayLink(target: Any, selector: Selector) -> CADisplayLink {
      CADisplayLink(target: target, selector: selector)
    }

    /// Calls `lost` when the app leaves the active state: the first sign of
    /// a lock, a sleeping display or another app taking the screen.
    func watchVisibility(_ lost: @escaping @MainActor @Sendable () -> Void) -> () -> Void {
      let token = NotificationCenter.default.addObserver(
        forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
      ) { _ in
        MainActor.assumeIsolated { lost() }
      }
      return { NotificationCenter.default.removeObserver(token) }
    }
  #endif
}

extension GridScrollTarget {
  fileprivate var rank: (Double, Double) {
    (Double(viewport.width), maximumOffset - minimumOffset)
  }
}

@MainActor
final class GridScrollDriver: NSObject {
  struct Pass {
    let frames: [DisplayFrame]
    let reachedBottom: Bool
    let stayedVisible: Bool
  }

  private let grid: GridScrollTarget
  private let pointsPerSecond: Double
  private var frames: [DisplayFrame] = []
  private var pending: (timestamp: Double, period: Double)?
  private var origin: (timestamp: Double, offset: Double)?
  private var reachedBottom = false
  private var stayedVisible = true
  private var stopWatchingVisibility: (() -> Void)?
  private var link: CADisplayLink?
  private var commitObserver: CFRunLoopObserver?
  private var watchdog: Task<Void, Never>?
  private var continuation: CheckedContinuation<Pass, Never>?

  init(grid: GridScrollTarget, pointsPerSecond: Double) {
    self.grid = grid
    self.pointsPerSecond = pointsPerSecond
  }

  /// A display link stops calling back when the window is hidden or the
  /// display sleeps, so the pass also ends, unfinished, after `limit`.
  func scrollToBottom(givingUpAfter limit: Duration) async -> Pass {
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
      let fastest = Float(grid.displayMaximumHz)
      // One fixed rate, the display's fastest: a link allowed to step between
      // rates would put every step on the classifier's 1.5-period threshold.
      if fastest > 0 {
        link.preferredFrameRateRange = CAFrameRateRange(
          minimum: fastest, maximum: fastest, preferred: fastest)
      }
      link.add(to: .main, forMode: .common)
      self.link = link
      stopWatchingVisibility = grid.watchVisibility { [weak self] in self?.stayedVisible = false }
      watchdog = Task { [weak self] in
        try? await Task.sleep(for: limit)
        guard !Task.isCancelled else { return }
        self?.finish()
      }
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
    if reachedBottom { finish() }
  }

  private func finish() {
    guard let continuation else { return }
    self.continuation = nil
    link?.invalidate()
    link = nil
    if let commitObserver {
      CFRunLoopRemoveObserver(CFRunLoopGetMain(), commitObserver, .commonModes)
    }
    commitObserver = nil
    watchdog?.cancel()
    watchdog = nil
    stopWatchingVisibility?()
    stopWatchingVisibility = nil
    continuation.resume(
      returning: Pass(frames: frames, reachedBottom: reachedBottom, stayedVisible: stayedVisible))
  }
}
