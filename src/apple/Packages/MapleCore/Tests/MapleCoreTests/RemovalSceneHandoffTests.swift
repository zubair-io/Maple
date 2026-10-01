import Foundation
import XCTest

@testable import MapleCore

final class RemovalSceneHandoffTests: XCTestCase {
  private func data(_ name: String, _ ext: String) throws -> Data {
    let url = try XCTUnwrap(
      Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "removal/calibration"))
    return try Data(contentsOf: url)
  }

  func testStrippingKeepsNamespaceOwnedRemovalRecordsAndRejectsMalformedOwnedMetadata() throws {
    let original = String(decoding: try data("saved", "xmp"), as: UTF8.self)
    let records = try XCTUnwrap(RemovalXMPRecords.read(Data(original.utf8)))
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let sidecar = directory.appendingPathComponent("photo.xmp")
    for xml in [
      original,
      original.replacingOccurrences(of: "papp:", with: "alias:").replacingOccurrences(
        of: "xmlns:papp", with: "xmlns:alias"),
    ] {
      try xml.write(to: sidecar, atomically: true, encoding: .utf8)
      var temporary: URL?
      try RawCoreBridge.withStrippedXMP(sidecar) { url in
        temporary = try XCTUnwrap(url)
        let stripped = try Data(contentsOf: XCTUnwrap(url))
        XCTAssertEqual(try RemovalXMPRecords.read(stripped), records)
        XCTAssertFalse(String(decoding: stripped, as: UTF8.self).contains("crs:Temperature="))
      }
      XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(temporary).path))
      XCTAssertEqual(try String(contentsOf: sidecar, encoding: .utf8), xml)
    }
    try original.replacingOccurrences(of: "&quot;schema&quot;:4", with: "&quot;schema&quot;:999")
      .write(to: sidecar, atomically: true, encoding: .utf8)
    XCTAssertThrowsError(
      try RawCoreBridge.withStrippedXMP(sidecar) { _ in
        XCTFail("Malformed saved edit cannot fall back to defaults")
      })
  }

  func testOrdinarySizedSceneDecodeIncludesSavedPatchAndPreservesUnselectedSamples() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let raw = directory.appendingPathComponent("photo.dng")
    let xmp = directory.appendingPathComponent("photo.xmp")
    let source = try data("source", "dng")
    try source.write(to: raw)
    let xml = String(decoding: try data("saved", "xmp"), as: UTF8.self)
    try xml.write(to: xmp, atomically: true, encoding: .utf8)
    let assets = directory.appendingPathComponent(".maple/inpaint")
    try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
    for (name, ext, suffix) in [("mask", "mimf", "mask"), ("patch", "f16", "f16")] {
      let bytes = try data(name, ext)
      let digest = String(try RemovalBridge.digest(bytes).dropFirst(7))
      try bytes.write(to: assets.appendingPathComponent("\(digest).\(suffix)"))
    }
    // Hold global AE fixed to isolate untouched native samples from whole-frame re-anchoring.
    let saved = try PipelineRenderer.renderSceneLinearSized(
      rawPath: raw, xmpPath: xmp, quality: .amaze, maxLongEdge: 64,
      profileOverride: .auto, autoExposureOverride: .off)
    XCTAssertEqual(saved.width, 16)
    XCTAssertEqual(saved.height, 8)
    XCTAssertEqual(saved.bytesPerPixel, 16)
    let original = try PipelineRenderer.renderSceneLinearSized(
      rawPath: raw, quality: .amaze, maxLongEdge: 64, profileOverride: .auto,
      autoExposureOverride: .off)
    XCTAssertEqual(saved.whitesAnchorEv, original.whitesAnchorEv)
    var changed = false
    for y in 0..<8 {
      for x in 0..<16 {
        let range = ((y * 16 + x) * 16)..<((y * 16 + x + 1) * 16)
        if (4..<12).contains(x), (2..<6).contains(y) {
          changed = changed || saved.pixels[range] != original.pixels[range]
        } else {
          XCTAssertEqual(
            saved.pixels[range], original.pixels[range],
            "Unselected native sample changed at \(x),\(y)")
        }
      }
    }
    XCTAssertTrue(changed)
    try FileManager.default.removeItem(at: assets)
    XCTAssertThrowsError(
      try PipelineRenderer.renderSceneLinearSized(
        rawPath: raw, xmpPath: xmp, quality: .amaze, maxLongEdge: 64,
        profileOverride: .auto, autoExposureOverride: .off))
    XCTAssertEqual(try Data(contentsOf: raw), source)
    XCTAssertEqual(try String(contentsOf: xmp, encoding: .utf8), xml)
  }
}
