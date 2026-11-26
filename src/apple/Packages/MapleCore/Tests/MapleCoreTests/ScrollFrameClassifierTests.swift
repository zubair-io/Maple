import XCTest

@testable import MapleCore

final class ScrollFrameClassifierTests: XCTestCase {
  private let hz60 = 1.0 / 60
  private let hz120 = 1.0 / 120

  private func frames(
    period: Double, intervals: [Double], commitFraction: Double = 0.5
  ) -> [DisplayFrame] {
    var timestamp = 100.0
    return ([0] + intervals).map { interval in
      timestamp += interval
      return DisplayFrame(
        timestamp: timestamp, period: period, committed: timestamp + period * commitFraction)
    }
  }

  func test_anIntervalUnderOneAndAHalfPeriodsDropsNothing() {
    XCTAssertEqual(ScrollFrameClassifier.skippedRefreshes(interval: hz60, period: hz60), 0)
    XCTAssertEqual(ScrollFrameClassifier.skippedRefreshes(interval: 0.2 * hz60, period: hz60), 0)
    XCTAssertEqual(ScrollFrameClassifier.skippedRefreshes(interval: 0, period: hz60), 0)
    XCTAssertEqual(ScrollFrameClassifier.skippedRefreshes(interval: 1.4 * hz60, period: hz60), 0)
    XCTAssertEqual(ScrollFrameClassifier.skippedRefreshes(interval: hz120, period: hz120), 0)
    XCTAssertEqual(ScrollFrameClassifier.skippedRefreshes(interval: 1.4 * hz120, period: hz120), 0)
  }

  func test_at60HzEachWholePeriodBeyondTheFirstIsOneDroppedFrame() {
    XCTAssertEqual(ScrollFrameClassifier.skippedRefreshes(interval: 1.6 * hz60, period: hz60), 1)
    XCTAssertEqual(ScrollFrameClassifier.skippedRefreshes(interval: 2 * hz60, period: hz60), 1)
    XCTAssertEqual(ScrollFrameClassifier.skippedRefreshes(interval: 3 * hz60, period: hz60), 2)
    XCTAssertEqual(ScrollFrameClassifier.skippedRefreshes(interval: 0.1, period: hz60), 5)
  }

  func test_at120HzTheSameIntervalsCostTwiceAsManyFrames() {
    XCTAssertEqual(ScrollFrameClassifier.skippedRefreshes(interval: 1.6 * hz120, period: hz120), 1)
    XCTAssertEqual(
      ScrollFrameClassifier.skippedRefreshes(interval: hz60, period: hz120), 1,
      "a 60 Hz cadence on a 120 Hz display misses every other refresh")
    XCTAssertEqual(ScrollFrameClassifier.skippedRefreshes(interval: 2 * hz60, period: hz120), 3)
    XCTAssertEqual(ScrollFrameClassifier.skippedRefreshes(interval: 0.1, period: hz120), 11)
  }

  func test_aPeriodOfZeroNeverCountsAsDropped() {
    XCTAssertEqual(ScrollFrameClassifier.skippedRefreshes(interval: 1, period: 0), 0)
    let frame = DisplayFrame(timestamp: 5, period: 0, committed: 9)
    XCTAssertEqual(ScrollFrameClassifier.presentedAt(frame), 5)
  }

  func test_aFrameLandsOnTheFirstRefreshAfterItsCommit() {
    func landing(committedAfter periods: Double, period: Double) -> Double {
      let frame = DisplayFrame(timestamp: 8, period: period, committed: 8 + periods * period)
      return (ScrollFrameClassifier.presentedAt(frame) - 8) / period
    }
    XCTAssertEqual(landing(committedAfter: 0.1, period: hz60), 1, accuracy: 1e-9)
    XCTAssertEqual(landing(committedAfter: 0.99, period: hz60), 1, accuracy: 1e-9)
    XCTAssertEqual(landing(committedAfter: 1.01, period: hz60), 2, accuracy: 1e-9)
    XCTAssertEqual(landing(committedAfter: 3.6, period: hz60), 4, accuracy: 1e-9)
    XCTAssertEqual(landing(committedAfter: 1.01, period: hz120), 2, accuracy: 1e-9)
    XCTAssertEqual(landing(committedAfter: -0.5, period: hz60), 1, accuracy: 1e-9)
  }

  func test_aSteadyScrollReportsEveryFrameAndNoDrops() {
    let stats = ScrollFrameClassifier.stats(
      for: frames(period: hz60, intervals: Array(repeating: hz60, count: 120)))
    XCTAssertEqual(stats.framesPresented, 121)
    XCTAssertEqual(stats.framesDropped, 0)
    XCTAssertEqual(stats.longestStallMs, 0)
    XCTAssertEqual(stats.stallMsPerSecond, 0)
    XCTAssertEqual(stats.scrollSeconds, 2, accuracy: 1e-9)
    XCTAssertEqual(stats.refreshHz, 60, accuracy: 1e-9)
    XCTAssertTrue(stats.worstStalls.isEmpty)
  }

  func test_aSkippedIntervalCountsItsMissedRefreshesAndStallTime() {
    let intervals =
      Array(repeating: hz60, count: 30) + [3 * hz60] + Array(repeating: hz60, count: 27)
    let stats = ScrollFrameClassifier.stats(for: frames(period: hz60, intervals: intervals))
    XCTAssertEqual(stats.framesPresented, 59)
    XCTAssertEqual(stats.framesDropped, 2)
    XCTAssertEqual(stats.longestStallMs, 2 * hz60 * 1000, accuracy: 1e-6)
    XCTAssertEqual(stats.scrollSeconds, 1, accuracy: 1e-9)
    XCTAssertEqual(stats.stallMsPerSecond, 2 * hz60 * 1000, accuracy: 1e-6)
    XCTAssertEqual(stats.worstStalls.count, 1)
    XCTAssertEqual(stats.worstStalls[0].atSeconds, 0.5, accuracy: 1e-9)
    XCTAssertEqual(stats.worstStalls[0].framesDropped, 2)
  }

  func test_at120HzAHundredMillisecondStallDropsElevenFrames() {
    let intervals = Array(repeating: hz120, count: 10) + [0.1] + Array(repeating: hz120, count: 10)
    let stats = ScrollFrameClassifier.stats(for: frames(period: hz120, intervals: intervals))
    XCTAssertEqual(stats.framesDropped, 11)
    XCTAssertEqual(stats.refreshHz, 120, accuracy: 1e-9)
  }

  func test_aLateCommitDropsAFrameEvenWhenTheNextCallbackArrives() {
    var sequence = frames(period: hz60, intervals: Array(repeating: hz60, count: 10))
    let late = sequence[4]
    sequence[4] = DisplayFrame(
      timestamp: late.timestamp, period: late.period,
      committed: late.timestamp + late.period * 1.3)
    let stats = ScrollFrameClassifier.stats(for: sequence)
    XCTAssertEqual(stats.framesDropped, 1)
    XCTAssertEqual(stats.longestStallMs, hz60 * 1000, accuracy: 1e-6)
  }

  func test_aLongCommitAndTheGapItCausesAreCountedOnce() {
    let intervals = Array(repeating: hz60, count: 5) + [4 * hz60] + Array(repeating: hz60, count: 5)
    var sequence = frames(period: hz60, intervals: intervals)
    let slow = sequence[5]
    sequence[5] = DisplayFrame(
      timestamp: slow.timestamp, period: slow.period,
      committed: slow.timestamp + slow.period * 3.6)
    XCTAssertEqual(ScrollFrameClassifier.stats(for: sequence).framesDropped, 3)
  }

  func test_aFrameThatLandsWithTheNextOneWasNeverShown() {
    var sequence = frames(period: hz60, intervals: Array(repeating: hz60, count: 10))
    let late = sequence[4]
    sequence[4] = DisplayFrame(
      timestamp: late.timestamp, period: late.period,
      committed: late.timestamp + late.period * 1.3)
    let stats = ScrollFrameClassifier.stats(for: sequence)
    XCTAssertEqual(stats.framesPresented, 10, "eleven produced, one replaced before a refresh")
    XCTAssertEqual(stats.framesDropped, 1)
  }

  func test_aScrollRunningOneRefreshBehindDropsNothing() {
    let behind = frames(
      period: hz60, intervals: Array(repeating: hz60, count: 60), commitFraction: 1.4)
    let stats = ScrollFrameClassifier.stats(for: behind)
    XCTAssertEqual(stats.framesDropped, 0)
    XCTAssertEqual(stats.framesPresented, 61)
  }

  func test_aLateLastFrameIsCounted() {
    var sequence = frames(period: hz60, intervals: Array(repeating: hz60, count: 3))
    let last = sequence[3]
    sequence[3] = DisplayFrame(
      timestamp: last.timestamp, period: last.period,
      committed: last.timestamp + 2.5 * hz60)
    XCTAssertEqual(ScrollFrameClassifier.stats(for: sequence).framesDropped, 2)
  }

  func test_theRefreshRateIsTheMedianPeriod() {
    let mixed =
      frames(period: hz120, intervals: Array(repeating: hz120, count: 6))
      + frames(period: hz60, intervals: Array(repeating: hz60, count: 2)).map {
        DisplayFrame(
          timestamp: $0.timestamp + 1, period: $0.period, committed: $0.committed + 1)
      }
    XCTAssertEqual(ScrollFrameClassifier.stats(for: mixed).refreshHz, 120, accuracy: 1e-9)
  }

  func test_worstStallsAreTheLongestFirstAndCapped() {
    let intervals = (0..<25).flatMap { index in [hz60, Double(index + 2) * hz60] }
    let stats = ScrollFrameClassifier.stats(for: frames(period: hz60, intervals: intervals))
    XCTAssertEqual(stats.framesDropped, (1...25).reduce(0, +))
    XCTAssertEqual(stats.worstStalls.count, 20)
    XCTAssertEqual(stats.worstStalls.first?.framesDropped, 25)
    XCTAssertEqual(stats.worstStalls.last?.framesDropped, 6)
    XCTAssertEqual(stats.longestStallMs, 25 * hz60 * 1000, accuracy: 1e-6)
    XCTAssertEqual(stats.scrollSeconds, 375 * hz60, accuracy: 1e-9)
    XCTAssertEqual(stats.stallMsPerSecond, 325 * 1000 / 375, accuracy: 1e-6)
  }

  func test_anIntervalIsJudgedAgainstThePeriodTheEarlierFramePromised() {
    let promised120 = DisplayFrame(timestamp: 10, period: hz120, committed: 10.001)
    let arrivedAt60 = DisplayFrame(timestamp: 10 + hz60, period: hz60, committed: 10 + hz60)
    XCTAssertEqual(
      ScrollFrameClassifier.stats(for: [promised120, arrivedAt60]).framesDropped, 2,
      "shown at 1/120 s and next at 4/120 s: two 120 Hz refreshes repeated the picture")
  }

  func test_fewerThanTwoFramesMeasureNothing() {
    XCTAssertEqual(ScrollFrameClassifier.stats(for: []).framesPresented, 0)
    let one = ScrollFrameClassifier.stats(for: frames(period: hz60, intervals: []))
    XCTAssertEqual(one.framesPresented, 1)
    XCTAssertEqual(one.framesDropped, 0)
    XCTAssertEqual(one.scrollSeconds, 0)
    XCTAssertEqual(one.refreshHz, 60, accuracy: 1e-9)
  }

  func test_aPassReportDerivesItsSpeedFromDistanceAndTime() {
    let pass = ScrollPassReport(
      name: "first", frames: frames(period: hz60, intervals: Array(repeating: hz60, count: 120)),
      distancePoints: 3000, thumbnailLoadsInFlightAtStart: 7)
    XCTAssertEqual(pass.pointsPerSecond, 1500, accuracy: 1e-6)
    XCTAssertEqual(pass.stats.framesPresented, 121)
  }

  func test_aRunThatMeasuredNothingDoesNotClaimItsFramesWereVisible() {
    XCTAssertNil(ScrollRunReport().framesVisible)
  }

  func test_theReportKeepsTheKeysTheMeasurementScriptReads() throws {
    var report = ScrollRunReport()
    report.error = "stopped"
    report.framesVisible = true
    report.passes = [
      ScrollPassReport(
        name: "first",
        frames: frames(period: hz60, intervals: [hz60, 3 * hz60]),
        distancePoints: 100, thumbnailLoadsInFlightAtStart: 0)
    ]
    let json = try XCTUnwrap(
      JSONSerialization.jsonObject(with: JSONEncoder().encode(report)) as? [String: Any])
    XCTAssertEqual(
      Set(json.keys),
      [
        "error", "passes", "photoCount", "reusedFolder", "device", "system", "build",
        "displayMaximumHz", "viewportWidth", "viewportHeight", "framesVisible",
        "loadAverageAtStart", "loadAverageAtEnd", "thermalState", "lowPowerMode", "primeSeconds",
      ])
    let pass = try XCTUnwrap((json["passes"] as? [[String: Any]])?.first)
    XCTAssertEqual(
      Set(pass.keys),
      [
        "name", "stats", "distancePoints", "pointsPerSecond", "thumbnailLoadsInFlightAtStart",
        "frames",
      ])
    let stats = try XCTUnwrap(pass["stats"] as? [String: Any])
    XCTAssertEqual(
      Set(stats.keys),
      [
        "framesPresented", "framesDropped", "longestStallMs", "stallMsPerSecond", "scrollSeconds",
        "refreshHz", "worstStalls",
      ])
    let frame = try XCTUnwrap((pass["frames"] as? [[String: Any]])?.first)
    XCTAssertEqual(Set(frame.keys), ["timestamp", "period", "committed"])
  }
}
