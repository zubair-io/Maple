// ScrollFrameStats.swift — turns the display link's frame record of a grid
// scroll into dropped-frame figures (#6048).
//
// Each display-link callback is one frame the app tried to produce. The frame
// reaches the screen at the first display refresh after its layout and commit
// finished, so a commit that overruns its refresh lands one or more refreshes
// late. A refresh that no frame landed on is a dropped frame: the display
// repeated the previous picture. That covers both ways a scroll stutters — the
// main thread busy across whole refreshes (no callback at all), and a commit
// that finished just too late — and it does not count a scroll that runs a
// steady refresh behind but still delivers one frame per refresh.
//
// Every interval is measured against the refresh period the display link
// reported for that frame, so 60 Hz and 120 Hz are judged alike. Stall time is
// the time the picture stood still beyond one period, which is what
// Instruments reports as hitch duration.

import Foundation

public struct DisplayFrame: Codable, Sendable, Equatable {
  public let timestamp: Double
  public let period: Double
  public let committed: Double

  public init(timestamp: Double, period: Double, committed: Double) {
    self.timestamp = timestamp
    self.period = period
    self.committed = committed
  }
}

public struct ScrollStall: Codable, Sendable, Equatable {
  public let atSeconds: Double
  public let stallMs: Double
  public let framesDropped: Int
}

public struct ScrollFrameStats: Codable, Sendable, Equatable {
  public let framesPresented: Int
  public let framesDropped: Int
  public let longestStallMs: Double
  public let stallMsPerSecond: Double
  public let scrollSeconds: Double
  public let refreshHz: Double
  public let worstStalls: [ScrollStall]
}

public enum ScrollFrameClassifier {
  public static let droppedIntervalFactor = 1.5
  static let reportedStallLimit = 20

  /// Refreshes that showed no new frame between two that did, `interval` apart.
  public static func skippedRefreshes(interval: Double, period: Double) -> Int {
    guard period > 0, interval > period * droppedIntervalFactor else { return 0 }
    return Int((interval / period).rounded()) - 1
  }

  /// The refresh a frame lands on: the first one after its commit finished.
  public static func presentedAt(_ frame: DisplayFrame) -> Double {
    guard frame.period > 0 else { return frame.timestamp }
    let refreshesLate = max(0, ((frame.committed - frame.timestamp) / frame.period).rounded(.down))
    return frame.timestamp + (refreshesLate + 1) * frame.period
  }

  public static func stats(for frames: [DisplayFrame]) -> ScrollFrameStats {
    guard let first = frames.first, let last = frames.last, frames.count > 1 else {
      return ScrollFrameStats(
        framesPresented: frames.count, framesDropped: 0, longestStallMs: 0,
        stallMsPerSecond: 0, scrollSeconds: 0, refreshHz: 0, worstStalls: [])
    }
    let start = presentedAt(first)
    let stalls = zip(frames, frames.dropFirst()).compactMap { previous, frame -> ScrollStall? in
      let shown = presentedAt(previous)
      let dropped = skippedRefreshes(interval: presentedAt(frame) - shown, period: previous.period)
      guard dropped > 0 else { return nil }
      return ScrollStall(
        atSeconds: shown - start, stallMs: Double(dropped) * previous.period * 1000,
        framesDropped: dropped)
    }
    let scrollSeconds = presentedAt(last) - start
    let periods = frames.map(\.period).sorted()
    let medianPeriod = periods[periods.count / 2]
    let stallMs = stalls.reduce(0) { $0 + $1.stallMs }
    return ScrollFrameStats(
      framesPresented: frames.count - 1,
      framesDropped: stalls.reduce(0) { $0 + $1.framesDropped },
      longestStallMs: stalls.map(\.stallMs).max() ?? 0,
      stallMsPerSecond: scrollSeconds > 0 ? stallMs / scrollSeconds : 0,
      scrollSeconds: scrollSeconds,
      refreshHz: medianPeriod > 0 ? 1 / medianPeriod : 0,
      worstStalls: Array(
        stalls.sorted { $0.stallMs > $1.stallMs }.prefix(reportedStallLimit)))
  }
}

public struct ScrollPassReport: Codable, Sendable {
  public let name: String
  public let stats: ScrollFrameStats
  public let distancePoints: Double
  public let pointsPerSecond: Double
  public let thumbnailLoadsInFlightAtStart: Int
  public let frames: [DisplayFrame]

  public init(
    name: String, frames: [DisplayFrame], distancePoints: Double,
    thumbnailLoadsInFlightAtStart: Int
  ) {
    let stats = ScrollFrameClassifier.stats(for: frames)
    self.name = name
    self.stats = stats
    self.distancePoints = distancePoints
    self.pointsPerSecond = stats.scrollSeconds > 0 ? distancePoints / stats.scrollSeconds : 0
    self.thumbnailLoadsInFlightAtStart = thumbnailLoadsInFlightAtStart
    self.frames = frames
  }
}

public struct ScrollRunReport: Codable, Sendable {
  public var error: String?
  public var passes: [ScrollPassReport] = []
  public var photoCount = 0
  public var reusedFolder = false
  public var device = ""
  public var system = ""
  public var build = ""
  public var displayMaximumHz = 0
  public var viewportWidth = 0.0
  public var viewportHeight = 0.0
  public var displayAwake = true
  public var screenLocked = false
  public var windowVisible = true
  public var loadAverageAtStart = 0.0
  public var loadAverageAtEnd = 0.0
  public var thermalState = ""
  public var lowPowerMode = false
  public var primeSeconds = 0.0

  public init() {}
}
