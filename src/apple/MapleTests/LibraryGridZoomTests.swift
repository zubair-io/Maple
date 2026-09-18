// LibraryGridZoomTests.swift — unit tests for the pure pinch-to-resize
// geometry in `Maple/Views/LibraryGridZoom.swift`. App-target sibling of
// PreviewViewVMTests (same `@testable import Maple` arrangement).

import Foundation
import XCTest

@testable import Maple

final class LibraryGridZoomTests: XCTestCase {

  /// iPhone 17 Pro grid width: 402pt screen minus the 2pt padding each side.
  private let width: CGFloat = 398

  // MARK: - One tier's layout

  func testCellSizeAccountsForGutters() {
    XCTAssertEqual(LibraryGridZoom.cellSize(columns: 1, width: width), 398)
    XCTAssertEqual(LibraryGridZoom.cellSize(columns: 3, width: width), (398 - 4) / 3, accuracy: 1e-9)
    XCTAssertEqual(LibraryGridZoom.cellSize(columns: 5, width: width), (398 - 8) / 5, accuracy: 1e-9)
  }

  func testCellRectWalksRowsAndColumns() {
    let size = LibraryGridZoom.cellSize(columns: 3, width: width)
    let r4 = LibraryGridZoom.cellRect(index: 4, columns: 3, width: width)
    XCTAssertEqual(r4.minX, size + 2, accuracy: 1e-9)
    XCTAssertEqual(r4.minY, size + 2, accuracy: 1e-9)
    XCTAssertEqual(r4.width, size, accuracy: 1e-9)
    XCTAssertEqual(r4.height, size, accuracy: 1e-9)
    let r2 = LibraryGridZoom.cellRect(index: 2, columns: 3, width: width)
    XCTAssertEqual(r2.maxX, width, accuracy: 1e-9)
  }

  func testGridHeightMatchesRowsAndGutters() {
    let size = LibraryGridZoom.cellSize(columns: 3, width: width)
    XCTAssertEqual(LibraryGridZoom.gridHeight(count: 0, columns: 3, width: width), 0)
    XCTAssertEqual(LibraryGridZoom.gridHeight(count: 1, columns: 3, width: width), size, accuracy: 1e-9)
    XCTAssertEqual(LibraryGridZoom.gridHeight(count: 7, columns: 3, width: width), 3 * size + 4, accuracy: 1e-9)
  }

  func testFocalCellFindsTheCellUnderAPoint() {
    let size = LibraryGridZoom.cellSize(columns: 3, width: width)
    let hit = LibraryGridZoom.focalCell(
      at: CGPoint(x: size + 2 + size / 4, y: size + 2 + size / 2), columns: 3, width: width, count: 24)
    XCTAssertEqual(hit?.index, 4)
    XCTAssertEqual(hit!.fraction.x, 0.25, accuracy: 1e-6)
    XCTAssertEqual(hit!.fraction.y, 0.5, accuracy: 1e-6)
  }

  func testFocalCellClampsGuttersEdgesAndTheTail() {
    // Past the right edge / below the last row → last cell, fraction clamped.
    let far = LibraryGridZoom.focalCell(at: CGPoint(x: 10_000, y: 10_000), columns: 3, width: width, count: 7)
    XCTAssertEqual(far?.index, 6)
    XCTAssertEqual(far!.fraction.x, 1)
    // A negative point → first cell.
    let before = LibraryGridZoom.focalCell(at: CGPoint(x: -5, y: -5), columns: 3, width: width, count: 7)
    XCTAssertEqual(before?.index, 0)
    XCTAssertEqual(before!.fraction.x, 0)
    // The last row of an incomplete grid: column 2 of row 2 does not exist → clamp to the tail.
    let size = LibraryGridZoom.cellSize(columns: 3, width: width)
    let tail = LibraryGridZoom.focalCell(
      at: CGPoint(x: 2 * (size + 2) + 1, y: 2 * (size + 2) + 1), columns: 3, width: width, count: 7)
    XCTAssertEqual(tail?.index, 6)
    XCTAssertNil(LibraryGridZoom.focalCell(at: .zero, columns: 3, width: width, count: 0))
  }

  func testPointOfCellRoundTripsFocalCell() {
    let p = LibraryGridZoom.point(ofCell: 11, fraction: CGPoint(x: 0.3, y: 0.7), columns: 5, width: width)
    let back = LibraryGridZoom.focalCell(at: p, columns: 5, width: width, count: 24)
    XCTAssertEqual(back?.index, 11)
    XCTAssertEqual(back!.fraction.x, 0.3, accuracy: 1e-6)
    XCTAssertEqual(back!.fraction.y, 0.7, accuracy: 1e-6)
  }

  func testIndicesIntersectingAWindow() {
    let size = LibraryGridZoom.cellSize(columns: 3, width: width)
    // Rows 1 and 2 (partially) → cells 3..<9.
    let range = LibraryGridZoom.indices(
      intersecting: (size + 10)...(2 * (size + 2) + 5), columns: 3, width: width, count: 24)
    XCTAssertEqual(range, 3..<9)
    // A window past the end clamps to the last row.
    XCTAssertEqual(LibraryGridZoom.indices(intersecting: 5_000...6_000, columns: 3, width: width, count: 7), 6..<7)
    XCTAssertTrue(LibraryGridZoom.indices(intersecting: 0...10, columns: 3, width: width, count: 0).isEmpty)
  }

  // MARK: - Where a pinch is between the tiers

  func testNoMovementIsTheBaseTierAtProgressZero() {
    let i = LibraryGridZoom.interpolation(baseColumns: 3, magnification: 1, width: width)
    XCTAssertEqual(i.from, 3)
    XCTAssertEqual(i.progress, 0, accuracy: 1e-9)
    XCTAssertEqual(i.overscale, 1)
    XCTAssertEqual(i.settledColumns, 3)
  }

  func testPinchOutWalksTowardFewerColumns() {
    let three = LibraryGridZoom.cellSize(columns: 3, width: width)
    let two = LibraryGridZoom.cellSize(columns: 2, width: width)
    // Halfway between the 3-up and 2-up cell sizes.
    let m = ((three + two) / 2) / three
    let i = LibraryGridZoom.interpolation(baseColumns: 3, magnification: m, width: width)
    XCTAssertEqual(i.from, 3)
    XCTAssertEqual(i.to, 2)
    XCTAssertEqual(i.progress, 0.5, accuracy: 1e-6)
    XCTAssertEqual(i.settledColumns, 2)
    // Well past 2-up, on the way to 1-up: the pair shifts.
    let one = LibraryGridZoom.cellSize(columns: 1, width: width)
    let m2 = (two + (one - two) * 0.25) / three
    let j = LibraryGridZoom.interpolation(baseColumns: 3, magnification: m2, width: width)
    XCTAssertEqual(j.from, 2)
    XCTAssertEqual(j.to, 1)
    XCTAssertEqual(j.progress, 0.25, accuracy: 1e-6)
    XCTAssertEqual(j.settledColumns, 2)
  }

  func testPinchInWalksTowardMoreColumns() {
    let three = LibraryGridZoom.cellSize(columns: 3, width: width)
    let four = LibraryGridZoom.cellSize(columns: 4, width: width)
    let m = (three - (three - four) * 0.8) / three
    let i = LibraryGridZoom.interpolation(baseColumns: 3, magnification: m, width: width)
    XCTAssertEqual(i.from, 3)
    XCTAssertEqual(i.to, 4)
    XCTAssertEqual(i.progress, 0.8, accuracy: 1e-6)
    XCTAssertEqual(i.settledColumns, 4)
  }

  func testPastTheEndTiersRubberBands() {
    // Pinching out past full width from 1-up: same tier, damped overscale.
    let i = LibraryGridZoom.interpolation(baseColumns: 1, magnification: 2, width: width)
    XCTAssertEqual(i.from, 1)
    XCTAssertEqual(i.to, 1)
    XCTAssertEqual(i.progress, 0)
    XCTAssertGreaterThan(i.overscale, 1)
    XCTAssertLessThan(i.overscale, 1 + LibraryGridZoom.rubberBandCap)
    XCTAssertEqual(i.settledColumns, 1)
    // Pinching in past the densest tier: same tier, damped shrink below 1,
    // never past the cap however far the fingers go.
    let j = LibraryGridZoom.interpolation(baseColumns: 7, magnification: 0.5, width: width)
    XCTAssertEqual(j.from, 7)
    XCTAssertEqual(j.to, 7)
    XCTAssertLessThan(j.overscale, 1)
    XCTAssertGreaterThan(j.overscale, 1 / (1 + LibraryGridZoom.rubberBandCap))
    XCTAssertEqual(j.settledColumns, 7)
    let far = LibraryGridZoom.interpolation(baseColumns: 7, magnification: 0.001, width: width)
    XCTAssertEqual(far.overscale, 1 / (1 + LibraryGridZoom.rubberBandCap), accuracy: 1e-6)
    // The band itself: identity at rest, monotonic, capped.
    XCTAssertEqual(LibraryGridZoom.rubberBand(1), 1)
    XCTAssertLessThan(LibraryGridZoom.rubberBand(1.5), LibraryGridZoom.rubberBand(2))
    XCTAssertLessThan(LibraryGridZoom.rubberBand(2), LibraryGridZoom.rubberBand(4))
    XCTAssertEqual(LibraryGridZoom.rubberBand(1_000_000), 1 + LibraryGridZoom.rubberBandCap, accuracy: 1e-6)
    // A persisted count that is not a tier interpolates as the identity.
    let odd = LibraryGridZoom.interpolation(baseColumns: 6, magnification: 1.7, width: width)
    XCTAssertEqual(odd.from, 6)
    XCTAssertEqual(odd.to, 6)
    XCTAssertEqual(odd.progress, 0)
    XCTAssertEqual(odd.overscale, 1)
    // Exactly at the widest tier from 3-up is 1-up, progress 1, no overscale.
    let one = LibraryGridZoom.cellSize(columns: 1, width: width)
    let three = LibraryGridZoom.cellSize(columns: 3, width: width)
    let k = LibraryGridZoom.interpolation(baseColumns: 3, magnification: one / three, width: width)
    XCTAssertEqual(k.settledColumns, 1)
    XCTAssertEqual(k.overscale, 1, accuracy: 1e-6)
  }

  func testInterpolatedRectIsContinuousAcrossATierPair() {
    let start = LibraryGridZoom.interpolatedRect(index: 7, from: 3, to: 5, progress: 0, width: width)
    XCTAssertEqual(start, LibraryGridZoom.cellRect(index: 7, columns: 3, width: width))
    let end = LibraryGridZoom.interpolatedRect(index: 7, from: 3, to: 5, progress: 1, width: width)
    XCTAssertEqual(end, LibraryGridZoom.cellRect(index: 7, columns: 5, width: width))
    let mid = LibraryGridZoom.interpolatedRect(index: 7, from: 3, to: 5, progress: 0.5, width: width)
    XCTAssertEqual(mid.width, (start.width + end.width) / 2, accuracy: 1e-9)
    XCTAssertEqual(mid.minY, (start.minY + end.minY) / 2, accuracy: 1e-9)
  }

  func testOverlaySliceStaysBoundedHoweverDeepThePinch() {
    // 5000 photos; the pinch is on photo 4000, far down the grid. Every
    // tier's window is centred on THAT photo, so the union is a few screens
    // of the densest tier, not everything between the sparse tier's row and
    // the dense tier's row at the same y.
    let reach: CGFloat = 2 * 874
    let slice = LibraryGridZoom.overlaySlice(
      focalIndex: 4000, focalFraction: CGPoint(x: 0.5, y: 0.5), reach: reach, width: width, count: 5000)!
    XCTAssertTrue(slice.contains(4000))
    let densestPerScreen = 7 * Int((reach / (LibraryGridZoom.cellSize(columns: 7, width: width) + 2)).rounded(.up))
    XCTAssertLessThan(slice.count, 2 * densestPerScreen + 7 * 2)
    // Every tier's own window around the focal photo is inside the slice.
    for tier in LibraryGridZoom.columnTiers {
      let y = LibraryGridZoom.point(ofCell: 4000, fraction: CGPoint(x: 0.5, y: 0.5), columns: tier, width: width).y
      let own = LibraryGridZoom.indices(intersecting: (y - reach)...(y + reach), columns: tier, width: width, count: 5000)
      XCTAssertTrue(slice.lowerBound <= own.lowerBound && own.upperBound <= slice.upperBound, "tier \(tier)")
    }
    XCTAssertNil(LibraryGridZoom.overlaySlice(
      focalIndex: 0, focalFraction: .zero, reach: reach, width: width, count: 0))
  }

  func testHeightDeltaIsTheTargetTiersExtraRoom() {
    let toSparser = LibraryGridZoom.heightDelta(count: 30, from: 5, to: 3, width: width)
    XCTAssertEqual(
      toSparser,
      LibraryGridZoom.gridHeight(count: 30, columns: 3, width: width)
        - LibraryGridZoom.gridHeight(count: 30, columns: 5, width: width), accuracy: 1e-9)
    XCTAssertGreaterThan(toSparser, 0)
    XCTAssertLessThan(LibraryGridZoom.heightDelta(count: 30, from: 3, to: 5, width: width), 0)
    XCTAssertEqual(LibraryGridZoom.heightDelta(count: 30, from: 3, to: 3, width: width), 0)
  }

  // MARK: - Full-width tier with whole photos

  func testTiersAreDenseAndSquare() {
    XCTAssertEqual(LibraryGridZoom.columnTiers, [1, 2, 3, 4, 5, 7])
    let g = LibraryGridZoom.Geometry(width: width, count: 24)
    for columns in LibraryGridZoom.columnTiers {
      let r = g.cellRect(index: 7, columns: columns)
      XCTAssertEqual(r.width, r.height, accuracy: 1e-9, "tier \(columns) must be square")
      XCTAssertEqual(r, LibraryGridZoom.cellRect(index: 7, columns: columns, width: width))
      XCTAssertEqual(g.gridHeight(columns: columns), LibraryGridZoom.gridHeight(count: 24, columns: columns, width: width), accuracy: 1e-9)
      let p = CGPoint(x: 100, y: 500)
      XCTAssertEqual(g.focalCell(at: p, columns: columns)?.index, LibraryGridZoom.focalCell(at: p, columns: columns, width: width, count: 24)?.index)
      XCTAssertEqual(g.indices(intersecting: 300...900, columns: columns), LibraryGridZoom.indices(intersecting: 300...900, columns: columns, width: width, count: 24))
    }
    XCTAssertNil(LibraryGridZoom.Geometry(width: width, count: 0).focalCell(at: .zero, columns: 1))
  }

  func testNearestTierAndStoredValidation() {
    XCTAssertEqual(LibraryGridZoom.nearestColumns(cellWidth: 398, width: width), 1)
    XCTAssertEqual(LibraryGridZoom.nearestColumns(cellWidth: 130, width: width), 3)
    XCTAssertEqual(LibraryGridZoom.nearestColumns(cellWidth: 78, width: width), 5)
    XCTAssertEqual(LibraryGridZoom.nearestColumns(cellWidth: 56, width: width), 7)
    XCTAssertEqual(LibraryGridZoom.validatedColumns(5), 5)
    XCTAssertEqual(LibraryGridZoom.validatedColumns(4), 4)
    XCTAssertEqual(LibraryGridZoom.validatedColumns(6), 3)
    XCTAssertEqual(LibraryGridZoom.validatedColumns(-1), 3)
  }
}
