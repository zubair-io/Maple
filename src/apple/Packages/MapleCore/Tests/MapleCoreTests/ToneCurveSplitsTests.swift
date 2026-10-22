// ToneCurveSplitsTests.swift — unit tests for parametric split clamping and
// active region window weights (#5039).

import XCTest

@testable import MapleCore

final class ToneCurveSplitsTests: XCTestCase {
  func testImportedNeighborsCannotRaiseTheInteractiveUpperBound() {
    XCTAssertEqual(
      ToneCurveSplits.clampSplit(
        handle: .highlight, proposed: 50, shadow: 97, midtone: 98, highlight: 99), 90)
    XCTAssertEqual(
      ToneCurveSplits.clampSplit(
        handle: .midtone, proposed: 50, shadow: 97, midtone: 98, highlight: 99), 80)
  }

  func testClampSplitEnforcesNeighborMarginsAndOuterBounds() {
    // Shadow clamps to [10, min(70, midtone - 5)]
    XCTAssertEqual(
      ToneCurveSplits.clampSplit(
        handle: .shadow, proposed: 2, shadow: 25, midtone: 50, highlight: 75),
      10
    )
    XCTAssertEqual(
      ToneCurveSplits.clampSplit(
        handle: .shadow, proposed: 60, shadow: 25, midtone: 50, highlight: 75),
      45
    )

    // Midtone clamps to [max(20, shadow + 5), min(80, highlight - 5)]
    XCTAssertEqual(
      ToneCurveSplits.clampSplit(
        handle: .midtone, proposed: 20, shadow: 25, midtone: 50, highlight: 75),
      30
    )
    XCTAssertEqual(
      ToneCurveSplits.clampSplit(
        handle: .midtone, proposed: 80, shadow: 25, midtone: 50, highlight: 75),
      70
    )

    // Highlight clamps to [max(30, midtone + 5), 90]
    XCTAssertEqual(
      ToneCurveSplits.clampSplit(
        handle: .highlight, proposed: 40, shadow: 25, midtone: 50, highlight: 75),
      55
    )
    XCTAssertEqual(
      ToneCurveSplits.clampSplit(
        handle: .highlight, proposed: 98, shadow: 25, midtone: 50, highlight: 75),
      90
    )
  }

  func testRegionWindowsFormNonNegativePartitionUpToHighlightsCentre() {
    let c = ToneCurveSplits.regionCentres(shadow: 25, midtone: 50, highlight: 75)
    XCTAssertEqual(c, [12.5, 37.5, 62.5, 87.5])

    for i in 0...100 {
      let p = Double(i)
      let w = ToneCurveSplits.regionWindows(at: p, shadow: 25, midtone: 50, highlight: 75)
      for weight in w {
        XCTAssertGreaterThanOrEqual(weight, -1e-9)
      }
      if p <= c[3] {
        let sum = w.reduce(0, +)
        XCTAssertEqual(sum, 1.0, accuracy: 1e-6)
      }
    }
  }

  func testSampleRegionWindowShiftsWhenSplitsMove() {
    let defaultSamples = ToneCurveSplits.sampleRegionWindow(
      region: .shadows, shadow: 25, midtone: 50, highlight: 75, samples: 1000
    )
    let widenedSamples = ToneCurveSplits.sampleRegionWindow(
      region: .shadows, shadow: 40, midtone: 50, highlight: 75, samples: 1000
    )
    // Axis 30 maps to authoring x ≈ 0.01484; sampling x=0.015 tracks that shadow region.
    let wDefault = defaultSamples[15].weight
    let wWidened = widenedSamples[15].weight
    XCTAssertGreaterThan(wWidened, wDefault + 0.1)
  }
}
