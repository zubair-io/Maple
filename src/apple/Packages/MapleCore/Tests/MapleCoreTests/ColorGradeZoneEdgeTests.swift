import Foundation
import XCTest

@testable import MapleCore

final class ColorGradeZoneEdgeTests: XCTestCase {
  func testAuthoredEdgesSurviveARealSidecarReload() throws {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID()).xmp")
    defer { try? FileManager.default.removeItem(at: file) }
    for position in [0.313, 0.813, 0.125, 0.625, ColorGradeZoneEdge.anchor] {
      var authored = AdjustmentModel.default
      authored.colorGradeShadowEdge = ColorGradeZoneEdge.normalized(
        x: position, width: 1, range: ColorGradeZoneEdge.shadowRange)
      authored.colorGradeHighlightEdge = ColorGradeZoneEdge.normalized(
        x: position, width: 1, range: ColorGradeZoneEdge.highlightRange)
      let xml = XMPSerializer.serialize(model: authored, culling: CullingState())
      try xml.write(to: file, atomically: true, encoding: .utf8)
      let (loaded, _) = try XMPParser.parse(String(contentsOf: file, encoding: .utf8))
      XCTAssertEqual(loaded.colorGradeShadowEdge, authored.colorGradeShadowEdge)
      XCTAssertEqual(loaded.colorGradeHighlightEdge, authored.colorGradeHighlightEdge)
    }
  }

  func testPositionIsNormalisedOverTheStripWidth() {
    XCTAssertEqual(
      ColorGradeZoneEdge.normalized(x: 100, width: 400, range: ColorGradeZoneEdge.shadowRange),
      0.25, accuracy: 1e-12)
    XCTAssertEqual(
      ColorGradeZoneEdge.normalized(x: 320, width: 400, range: ColorGradeZoneEdge.highlightRange),
      0.8, accuracy: 1e-12)
  }

  func testBalanceWarpKeepsTheHandleAtThePlottedCrossover() {
    XCTAssertEqual(ColorGradeZoneEdge.plotPosition(edge: 0.5, balance: 100), 0.25, accuracy: 1e-12)
    XCTAssertEqual(
      ColorGradeZoneEdge.plotPosition(edge: 0.5, balance: -100), sqrt(0.5), accuracy: 1e-12)
    XCTAssertEqual(
      ColorGradeZoneEdge.normalized(
        x: 100, width: 400, range: ColorGradeZoneEdge.shadowRange, balance: 100), 0.5,
      accuracy: 1e-12)
    for balance in [-100.0, -40, 0, 40, 100] {
      for edge in [0.2, 0.4, 0.7, 0.8] {
        let position = ColorGradeZoneEdge.plotPosition(edge: edge, balance: balance)
        let range =
          edge < ColorGradeZoneEdge.anchor
          ? ColorGradeZoneEdge.shadowRange : ColorGradeZoneEdge.highlightRange
        XCTAssertEqual(
          ColorGradeZoneEdge.normalized(
            x: position * 400, width: 400, range: range, balance: balance), edge, accuracy: 1e-12)
      }
    }
  }

  func testPositionClampsToEachEdgesAuthoringRange() {
    XCTAssertEqual(
      ColorGradeZoneEdge.normalized(x: 4, width: 400, range: ColorGradeZoneEdge.shadowRange), 0.10)
    XCTAssertEqual(
      ColorGradeZoneEdge.normalized(x: 390, width: 400, range: ColorGradeZoneEdge.shadowRange),
      0.564622)
    XCTAssertEqual(
      ColorGradeZoneEdge.normalized(x: 100, width: 400, range: ColorGradeZoneEdge.highlightRange),
      0.564622)
    XCTAssertEqual(
      ColorGradeZoneEdge.normalized(x: 399, width: 400, range: ColorGradeZoneEdge.highlightRange),
      0.90)
  }

  func testRoundsToWirePrecisionAndSnapsToTheAnchorLikeTheOtherPlatforms() {
    // Normalised 0.5601 is within 0.005 of the anchor 0.564622.
    XCTAssertEqual(
      ColorGradeZoneEdge.normalized(x: 224.04, width: 400, range: ColorGradeZoneEdge.shadowRange),
      0.564622)
    XCTAssertEqual(
      ColorGradeZoneEdge.normalized(x: 225.9, width: 400, range: ColorGradeZoneEdge.highlightRange),
      0.564622)
    XCTAssertEqual(
      ColorGradeZoneEdge.normalized(x: 0.125, width: 1, range: ColorGradeZoneEdge.shadowRange), 0.13
    )
    XCTAssertEqual(
      ColorGradeZoneEdge.normalized(x: 0.625, width: 1, range: ColorGradeZoneEdge.highlightRange),
      0.63)
    // Far from the anchor it only rounds.
    XCTAssertEqual(
      ColorGradeZoneEdge.normalized(x: 100.4, width: 400, range: ColorGradeZoneEdge.shadowRange),
      0.25, accuracy: 1e-12)
  }

  func testAHandleLocalPositionWouldBeWrongForTheSameDrag() {
    let handleLocal = ColorGradeZoneEdge.normalized(
      x: 11, width: 400, range: ColorGradeZoneEdge.shadowRange)
    let stripSpace = ColorGradeZoneEdge.normalized(
      x: 226, width: 400, range: ColorGradeZoneEdge.shadowRange)
    XCTAssertNotEqual(handleLocal, stripSpace)
  }
}
