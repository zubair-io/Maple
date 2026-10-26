// LightTableMetricsTests.swift — Light Table stage geometry (#5457): Maple
// TV keeps its hand-tuned stage, and a fitted phone/tablet stage keeps every
// print on screen in both orientations.

import CoreGraphics
import XCTest

@testable import MapleCloudKit

final class LightTableMetricsTests: XCTestCase {
  private let screens: [CGSize] = [
    CGSize(width: 402, height: 874),
    CGSize(width: 874, height: 402),
    CGSize(width: 375, height: 667),
    CGSize(width: 1032, height: 1376),
    CGSize(width: 1376, height: 1032),
    CGSize(width: 744, height: 1133),
  ]

  func test_television_keepsTheOriginalStage() {
    let tv = LightTableMetrics.television
    XCTAssertEqual(tv.slotCount, 12)
    XCTAssertEqual(tv.stageHalfWidth, 660)
    XCTAssertEqual(tv.stageHalfHeight, 340)
    XCTAssertEqual(tv.imageSize, 300)
    XCTAssertEqual(tv.slotJitter, 60)
  }

  func test_televisionAnchor_mapsToTheOriginalSlotCentres() {
    let tv = LightTableMetrics.television
    for slot in 0..<tv.slotCount {
      let offset = tv.offset(for: tv.anchor(forSlot: slot))
      let column = Double(slot % 4)
      let row = Double(slot / 4)
      let centreX = ((column + 0.5) / 4 * 2 - 1) * 660
      let centreY = ((row + 0.5) / 3 * 2 - 1) * 340
      XCTAssertEqual(offset.width, centreX, accuracy: 60.0001)
      XCTAssertEqual(offset.height, centreY, accuracy: 60.0001)
    }
  }

  func test_fittedStage_keepsEveryPrintOnScreen() {
    for size in screens {
      let metrics = LightTableMetrics.fitting(size)
      let halfPrint = metrics.imageSize / 2 + metrics.matPadding
      for slot in 0..<metrics.slotCount {
        for _ in 0..<20 {
          let offset = metrics.offset(for: metrics.anchor(forSlot: slot))
          XCTAssertLessThanOrEqual(abs(offset.width) + halfPrint, size.width / 2, "\(size)")
          XCTAssertLessThanOrEqual(abs(offset.height) + halfPrint, size.height / 2, "\(size)")
        }
      }
    }
  }

  func test_anchor_staysInsideItsSlot() {
    for metrics in [LightTableMetrics.television] + screens.map(LightTableMetrics.fitting) {
      for slot in 0..<metrics.slotCount {
        XCTAssertEqual(metrics.slot(containing: metrics.anchor(forSlot: slot)), slot)
      }
    }
  }

  func test_slotContaining_mapsAnchorsIntoTheRotatedGrid() {
    let portrait = LightTableMetrics.fitting(CGSize(width: 402, height: 874))
    let landscape = LightTableMetrics.fitting(CGSize(width: 874, height: 402))
    for slot in 0..<portrait.slotCount {
      XCTAssertLessThan(
        landscape.slot(containing: portrait.anchor(forSlot: slot)), landscape.slotCount)
    }
  }

  func test_retainedAnchors_stayOnScreenAcrossRotation() {
    let rotations: [(CGSize, CGSize)] = [
      (CGSize(width: 874, height: 402), CGSize(width: 402, height: 874)),
      (CGSize(width: 402, height: 874), CGSize(width: 874, height: 402)),
      (CGSize(width: 1376, height: 1032), CGSize(width: 1032, height: 1376)),
      (CGSize(width: 1032, height: 1376), CGSize(width: 1376, height: 1032)),
    ]
    for (laidOut, rotated) in rotations {
      let before = LightTableMetrics.fitting(laidOut)
      let after = LightTableMetrics.fitting(rotated)
      let halfPrint = after.imageSize / 2 + after.matPadding
      for slot in 0..<before.slotCount {
        for _ in 0..<20 {
          let offset = after.offset(for: before.anchor(forSlot: slot))
          XCTAssertLessThanOrEqual(
            abs(offset.width) + halfPrint, rotated.width / 2, "\(laidOut) -> \(rotated)")
          XCTAssertLessThanOrEqual(
            abs(offset.height) + halfPrint, rotated.height / 2, "\(laidOut) -> \(rotated)")
        }
      }
    }
  }

  func test_offset_leavesCurrentGridAnchorsUnclamped() {
    for metrics in [LightTableMetrics.television] + screens.map(LightTableMetrics.fitting) {
      for slot in 0..<metrics.slotCount {
        let anchor = metrics.anchor(forSlot: slot)
        let offset = metrics.offset(for: anchor)
        XCTAssertEqual(offset.width, anchor.x * metrics.stageHalfWidth, accuracy: 1e-6)
        XCTAssertEqual(offset.height, anchor.y * metrics.stageHalfHeight, accuracy: 1e-6)
      }
    }
  }

  func test_fittedStage_keepsPrintSizeAcrossRotation() {
    let portrait = LightTableMetrics.fitting(CGSize(width: 1032, height: 1376))
    let landscape = LightTableMetrics.fitting(CGSize(width: 1376, height: 1032))
    XCTAssertEqual(portrait.imageSize, landscape.imageSize)
    XCTAssertGreaterThan(landscape.columns, portrait.columns)
  }

  func test_fittedStage_alwaysHasRoomForSeveralPrints() {
    for size in screens {
      XCTAssertGreaterThanOrEqual(LightTableMetrics.fitting(size).slotCount, 4, "\(size)")
    }
  }

  func test_printsGlideInFromTheRightAndLeaveFullyOffTheLeft() {
    for size in screens {
      let metrics = LightTableMetrics.fitting(size)
      let halfPrint = metrics.imageSize / 2 + metrics.matPadding
      let rightmostSettled = size.width / 2 - halfPrint
      XCTAssertGreaterThan(metrics.entryOffset, size.width / 2, "\(size)")
      XCTAssertLessThan(
        rightmostSettled - metrics.exitOffset + halfPrint, -size.width / 2, "\(size)")
    }
  }
}
