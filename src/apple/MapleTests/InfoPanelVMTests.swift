// InfoPanelVMTests.swift — unit tests for the S6 InfoPanel projection
// helpers in `Maple/Views/InfoPanel/InfoPanelView+VM.swift`.
//
// Lives in the MapleTests Xcode target (not MapleCore) because the
// `InfoPanelVM` enum is declared in the app target — that's where the
// view + its VM sibling live (per the `+VM.swift` co-location pattern).
// MapleTests is host-targeted on Maple.app, so `@testable import Maple`
// is the standard way to reach Maple-target types from a test bundle.

import MapleCore
import XCTest

@testable import Maple

final class InfoPanelVMTests: XCTestCase {
  // MARK: - cameraLocationRows

  func testCameraLocationRowsAlwaysProducesEightRows() {
    let entries: [ImageMetadataReader.ExifEntry] = []
    let rows = InfoPanelVM.cameraLocationRows(from: entries)
    XCTAssertEqual(rows.count, 8)
    XCTAssertEqual(
      rows.map(\.id),
      [
        "body", "lens", "aperture", "shutter", "iso", "focal", "coords", "city",
      ])
  }

  func testCameraLocationRowsFallsBackToEmDashWhenMissing() {
    let rows = InfoPanelVM.cameraLocationRows(from: [])
    for row in rows {
      XCTAssertEqual(row.value, "—", "row \(row.id) should fall back to em-dash")
    }
  }

  func testCameraLocationRowsExtractsCameraBodyAndExposure() {
    let entries: [ImageMetadataReader.ExifEntry] = [
      .init(section: "Camera", label: "Make", value: "Canon"),
      .init(section: "Camera", label: "Model", value: "EOS R5"),
      .init(section: "Camera", label: "Lens", value: "RF 24-70 F2.8"),
      .init(section: "Exposure", label: "Aperture", value: "f/8.0"),
      .init(section: "Exposure", label: "Shutter", value: "1/250"),
      .init(section: "Exposure", label: "ISO", value: "200"),
      .init(section: "Exposure", label: "Focal Length", value: "35mm"),
    ]
    let rows = InfoPanelVM.cameraLocationRows(from: entries)
    XCTAssertEqual(value(rows, "body"), "Canon EOS R5")
    XCTAssertEqual(value(rows, "lens"), "RF 24-70 F2.8")
    XCTAssertEqual(value(rows, "aperture"), "f/8.0")
    XCTAssertEqual(value(rows, "shutter"), "1/250")
    XCTAssertEqual(value(rows, "iso"), "200")
    XCTAssertEqual(value(rows, "focal"), "35mm")
  }

  func testCameraLocationRowsCoordsCombinesLatLon() {
    let entries: [ImageMetadataReader.ExifEntry] = [
      .init(section: "GPS", label: "Latitude", value: "48.8584"),
      .init(section: "GPS", label: "Longitude", value: "2.2945"),
    ]
    let rows = InfoPanelVM.cameraLocationRows(from: entries)
    XCTAssertEqual(value(rows, "coords"), "48.8584, 2.2945")
  }

  func testCameraLocationRowsCityIsAlwaysEmDashInV01() {
    // City requires reverse-geocoding; not wired in v0.1.
    let entries: [ImageMetadataReader.ExifEntry] = [
      .init(section: "GPS", label: "Latitude", value: "48.8584"),
      .init(section: "GPS", label: "Longitude", value: "2.2945"),
    ]
    let rows = InfoPanelVM.cameraLocationRows(from: entries)
    XCTAssertEqual(value(rows, "city"), "—")
  }

  // MARK: - combineMakeModel

  func testCombineMakeModelStripsLeadingMakePrefix() {
    XCTAssertEqual(
      InfoPanelVM.combineMakeModel(make: "Canon", model: "Canon EOS R5"),
      "Canon EOS R5")
  }

  func testCombineMakeModelJoinsWhenModelDoesNotIncludeMake() {
    XCTAssertEqual(
      InfoPanelVM.combineMakeModel(make: "Canon", model: "EOS R5"),
      "Canon EOS R5")
  }

  func testCombineMakeModelHandlesMissingFields() {
    XCTAssertEqual(InfoPanelVM.combineMakeModel(make: "Hasselblad", model: nil), "Hasselblad")
    XCTAssertEqual(InfoPanelVM.combineMakeModel(make: nil, model: "EOS R5"), "EOS R5")
    XCTAssertEqual(InfoPanelVM.combineMakeModel(make: nil, model: nil), "—")
  }

  // MARK: - combineCoords

  func testCombineCoordsPairsLatLon() {
    XCTAssertEqual(InfoPanelVM.combineCoords(lat: "1.0", lon: "2.0"), "1.0, 2.0")
    XCTAssertEqual(InfoPanelVM.combineCoords(lat: "1.0", lon: nil), "1.0")
    XCTAssertEqual(InfoPanelVM.combineCoords(lat: nil, lon: "2.0"), "2.0")
    XCTAssertEqual(InfoPanelVM.combineCoords(lat: nil, lon: nil), "—")
  }

  // MARK: - helpers

  private func value(_ rows: [InfoPanelVM.Row], _ id: String) -> String {
    rows.first(where: { $0.id == id })?.value ?? "<not found>"
  }
}
