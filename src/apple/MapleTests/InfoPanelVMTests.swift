// InfoPanelVMTests.swift — unit tests for the S6 InfoPanel projection
// helpers in `Maple/Views/InfoPanel/InfoPanelView+VM.swift`.
//
// Lives in the MapleTests Xcode target (not MapleCore) because the
// `InfoPanelVM` enum is declared in the app target — that's where the
// view + its VM sibling live (per the `+VM.swift` co-location pattern).
// MapleTests is host-targeted on Maple Exposure.app, so `@testable import Maple_Exposure`
// is the standard way to reach app-target types from a test bundle. The app
// target's product name is "Maple Exposure", so its Swift module name is
// `Maple_Exposure` (spaces become underscores).

import MapleCore
import XCTest

@testable import Maple_Exposure

final class InfoPanelVMTests: XCTestCase {
  // MARK: - cameraLocationRows

  func testCameraLocationRowsProducesTwelveRowsInOrder() {
    let entries: [ImageMetadataReader.ExifEntry] = []
    let rows = InfoPanelVM.cameraLocationRows(from: entries)
    XCTAssertEqual(rows.count, 12)
    XCTAssertEqual(
      rows.map(\.id),
      [
        "body", "taken", "lens", "aperture", "shutter", "iso", "focal",
        "dimensions", "coords", "city", "size", "folder",
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

  func testCameraLocationRowsCityFromEnrichmentElseEmDash() {
    // City comes from the server reverse-geocode (#2518); "—" when absent.
    let noCity = InfoPanelVM.cameraLocationRows(from: [])
    XCTAssertEqual(value(noCity, "city"), "—")
    let withCity = InfoPanelVM.cameraLocationRows(from: [], city: "Albany")
    XCTAssertEqual(value(withCity, "city"), "Albany")
  }

  func testCameraLocationRowsTakenAndDimensionsFromExif() {
    let entries: [ImageMetadataReader.ExifEntry] = [
      .init(section: "Camera", label: "Date Taken", value: "Jul 30, 2026 at 4:15 PM"),
      .init(section: "Image", label: "Resolution", value: "6000 × 4000"),
    ]
    let rows = InfoPanelVM.cameraLocationRows(from: entries)
    XCTAssertEqual(value(rows, "taken"), "Jul 30, 2026 at 4:15 PM")
    XCTAssertEqual(value(rows, "dimensions"), "6000 × 4000")
  }

  func testCameraLocationRowsSizePrefersCatalogElseExif() {
    // Catalog size (cloud) formats to a human string; EXIF File/Size is the
    // local fallback when no catalog size is passed.
    let withCatalog = InfoPanelVM.cameraLocationRows(from: [], fileSize: 42_000_000)
    XCTAssertEqual(value(withCatalog, "size"), InfoPanelVM.formatBytes(42_000_000))
    let exifOnly = InfoPanelVM.cameraLocationRows(
      from: [.init(section: "File", label: "Size", value: "12.3 MB")])
    XCTAssertEqual(value(exifOnly, "size"), "12.3 MB")
  }

  func testCameraLocationRowsFolderFromDisplayFolderElseEmDash() {
    let withFolder = InfoPanelVM.cameraLocationRows(from: [], folder: "photos/2010/Family")
    XCTAssertEqual(value(withFolder, "folder"), "photos/2010/Family")
    // No folder (e.g. PhotoKit) → em-dash; no EXIF File/Path fallback.
    let none = InfoPanelVM.cameraLocationRows(from: [])
    XCTAssertEqual(value(none, "folder"), "—")
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
