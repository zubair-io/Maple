// LaunchTimeline.swift — once-per-process launch milestones (#6017), measured
// from the kernel's process start so the "cold launch to browsable grid"
// budget is read from Instruments (Points of Interest) or the unified log.

import Foundation
import os

public enum LaunchMilestone: String, CaseIterable, Sendable {
  case appInit
  case shellAppeared
  case folderRestored
  case gridPublished
  case firstThumbnail
}

public final class LaunchTimeline: @unchecked Sendable {
  public static let shared = LaunchTimeline(processStart: LaunchTimeline.processStartDate())

  private let processStart: Date
  private let lock = NSLock()
  private var elapsedByMilestone: [LaunchMilestone: TimeInterval] = [:]
  private let signposter = OSSignposter(
    subsystem: "app.justmaple.aperture", category: .pointsOfInterest)
  private let logger = Logger(subsystem: "app.justmaple.aperture", category: "launch")

  init(processStart: Date) {
    self.processStart = processStart
  }

  /// Records `milestone` the first time it is reached in this process and
  /// returns its offset from process start; later calls return `nil`.
  @discardableResult
  public func mark(_ milestone: LaunchMilestone, at now: Date = Date()) -> TimeInterval? {
    let elapsed = now.timeIntervalSince(processStart)
    let isFirst = lock.withLock {
      guard elapsedByMilestone[milestone] == nil else { return false }
      elapsedByMilestone[milestone] = elapsed
      return true
    }
    guard isFirst else { return nil }
    let milliseconds = Int((elapsed * 1000).rounded())
    signposter.emitEvent("LaunchMilestone", "\(milestone.rawValue, privacy: .public) \(milliseconds) ms")
    logger.notice("launch \(milestone.rawValue, privacy: .public) at \(milliseconds) ms")
    return elapsed
  }

  public func elapsed(for milestone: LaunchMilestone) -> TimeInterval? {
    lock.withLock { elapsedByMilestone[milestone] }
  }

  static func processStartDate() -> Date {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
    guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0 else { return Date() }
    let start = info.kp_proc.p_un.__p_starttime
    return Date(
      timeIntervalSince1970: TimeInterval(start.tv_sec) + TimeInterval(start.tv_usec) / 1_000_000)
  }
}
