import XCTest

@testable import MapleCore

final class MapleSidecarPathsTests: XCTestCase {
  func testKeyMatchesFrozenCrossPlatformValue() {
    // MUST equal the Rust sha256_prefix16 and API/web values.
    XCTAssertEqual(MapleThumbCacheKey.sha256Prefix16("panorama-test.png"), "88bab9b0d022c93c")
  }

  func testThumbURLIsAssetRelativeCanonical() {
    let pano = URL(fileURLWithPath: "/a/b/Panoramas/panorama-test.png")
    XCTAssertEqual(
      MapleSidecarPaths.thumbURL(for: pano).path,
      "/a/b/Panoramas/.maple/thumbs/panorama-test.png.avif"
    )
  }

  func testPreviewURLIsCanonicalFilenameAvif() {
    // #2009 — preview is `<dir>/.maple/previews/<filename>.avif`, the
    // ORIGINAL filename incl. extension, no hash / size / version token.
    let pano = URL(fileURLWithPath: "/a/b/Panoramas/panorama-test.png")
    XCTAssertEqual(
      MapleSidecarPaths.previewURL(for: pano).path,
      "/a/b/Panoramas/.maple/previews/panorama-test.png.avif"
    )
  }

  func testPreviewURLKeepsRawExtensionInName() {
    // The extension stays in the name so `IMG.CR2` and `IMG.CR3` never
    // collide, and the file reads as "preview of <that exact original>".
    let raw = URL(fileURLWithPath: "/lib/Photos/2024/IMG_1234.CR2")
    XCTAssertEqual(
      MapleSidecarPaths.previewURL(for: raw).path,
      "/lib/Photos/2024/.maple/previews/IMG_1234.CR2.avif"
    )
  }

  // MARK: - Legacy `.v25` adoption (#4793)

  func testLegacyURLsAreTheFrozenV25Names() {
    let pano = URL(fileURLWithPath: "/a/b/Panoramas/panorama-test.png")
    XCTAssertEqual(
      MapleSidecarPaths.legacyThumbURL(for: pano).path,
      "/a/b/Panoramas/.maple/thumbs/88bab9b0d022c93c.v25.avif")
    XCTAssertEqual(
      MapleSidecarPaths.legacyPreviewURL(for: pano).path,
      "/a/b/Panoramas/.maple/previews/panorama-test.png.v25.avif")
  }

  func testReadDerivativeRenamesLegacyIntoPlaceOnMiss() throws {
    let dir = try scratchPreviewsDir()
    let current = dir.appendingPathComponent("IMG.CR2.avif")
    let legacy = dir.appendingPathComponent("IMG.CR2.v25.avif")
    try Data("legacy".utf8).write(to: legacy)

    XCTAssertEqual(MapleSidecarPaths.readDerivative(at: current, legacy: legacy), Data("legacy".utf8))
    XCTAssertFalse(FileManager.default.fileExists(atPath: legacy.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: current.path))
  }

  func testReadDerivativeHitLeavesLegacySiblingAlone() throws {
    let dir = try scratchPreviewsDir()
    let current = dir.appendingPathComponent("IMG.CR2.avif")
    let legacy = dir.appendingPathComponent("IMG.CR2.v25.avif")
    try Data("current".utf8).write(to: current)
    try Data("legacy".utf8).write(to: legacy)

    XCTAssertEqual(MapleSidecarPaths.readDerivative(at: current, legacy: legacy), Data("current".utf8))
    XCTAssertTrue(FileManager.default.fileExists(atPath: legacy.path))
  }

  func testReadDerivativeIgnoresOtherVersions() throws {
    let dir = try scratchPreviewsDir()
    try Data("older".utf8).write(to: dir.appendingPathComponent("IMG.CR2.v24.avif"))

    XCTAssertNil(
      MapleSidecarPaths.readDerivative(
        at: dir.appendingPathComponent("IMG.CR2.avif"),
        legacy: dir.appendingPathComponent("IMG.CR2.v25.avif")))
  }

  func testRemoveDerivativeAlsoRemovesTheLegacySibling() throws {
    let dir = try scratchPreviewsDir()
    let current = dir.appendingPathComponent("IMG.CR2.avif")
    let legacy = dir.appendingPathComponent("IMG.CR2.v25.avif")
    try Data("current".utf8).write(to: current)
    try Data("legacy".utf8).write(to: legacy)

    MapleSidecarPaths.removeDerivative(at: current, legacy: legacy)

    XCTAssertFalse(FileManager.default.fileExists(atPath: current.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: legacy.path))
  }

  private func scratchPreviewsDir() throws -> URL {
    let dir = FileManager.default.temporaryDirectory
      .appendingPathComponent("sidecar-paths-\(UUID().uuidString)/.maple/previews")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    addTeardownBlock {
      try? FileManager.default.removeItem(at: dir.deletingLastPathComponent().deletingLastPathComponent())
    }
    return dir
  }
}
