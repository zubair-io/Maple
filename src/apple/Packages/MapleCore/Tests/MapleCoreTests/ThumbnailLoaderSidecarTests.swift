import CoreImage
import XCTest

@testable import MapleCore

final class ThumbnailLoaderSidecarTests: XCTestCase {
  func testLoadReturnsAssetRelativeMapleThumb() async throws {
    let fm = FileManager.default
    let base = fm.temporaryDirectory.appendingPathComponent("ttl-\(UUID().uuidString)")
    // Configure the singleton cache for a DIFFERENT folder (mirrors the
    // open-folder vs Panoramas/-subfolder mismatch).
    let openFolder = base.appendingPathComponent("open")
    let panoFolder = base.appendingPathComponent("open/Panoramas")
    defer { try? fm.removeItem(at: base) }
    try fm.createDirectory(at: openFolder, withIntermediateDirectories: true)
    try fm.createDirectory(at: panoFolder, withIntermediateDirectories: true)
    await ThumbnailDiskCache.shared.configure(folderURL: openFolder)

    // Write a canonical asset-relative thumb next to the pano.
    let panoURL = panoFolder.appendingPathComponent("panorama-test.png")
    try Data([1, 2, 3, 4, 5]).write(to: panoURL)  // stand-in pano bytes
    let thumbURL = MapleSidecarPaths.thumbURL(for: panoURL)
    try fm.createDirectory(
      at: thumbURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    // #4037: the cache reader validates derivatives, so use actual AVIF.
    let image = CIImage(color: .red).cropped(to: CGRect(x: 0, y: 0, width: 256, height: 128))
    let expected = try XCTUnwrap(ThumbnailLoader.encodeDisplayPreview(from: image))
    try expected.write(to: thumbURL)
    LocalDerivativeSourceStamp.record(thumbURL, for: panoURL)

    let got = await ThumbnailLoader.shared.load(for: panoURL)
    XCTAssertEqual(got, expected)

  }

  func testRemovedSidecarCannotRestampOldThumbnailAsFresh() async throws {
    let fm = FileManager.default
    let folder = fm.temporaryDirectory.appendingPathComponent(
      "external-xmp-thumb-\(UUID().uuidString)")
    try fm.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: folder) }
    let asset = folder.appendingPathComponent("photo.png")
    let blue = CIImage(color: .blue).cropped(to: CGRect(x: 0, y: 0, width: 320, height: 200))
    let source = try XCTUnwrap(
      CIContext().pngRepresentation(
        of: blue, format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB()))
    try source.write(to: asset)
    let sidecar = SidecarPath.sidecarURL(for: asset)
    try Data("<xmp>edited</xmp>".utf8).write(to: sidecar)

    let staleImage = CIImage(color: .red).cropped(to: CGRect(x: 0, y: 0, width: 256, height: 256))
    let stale = try XCTUnwrap(ThumbnailLoader.encodeDisplayPreview(from: staleImage))
    let thumb = MapleSidecarPaths.thumbURL(for: asset)
    try fm.createDirectory(at: thumb.deletingLastPathComponent(), withIntermediateDirectories: true)
    try stale.write(to: thumb)
    LocalDerivativeSourceStamp.record(thumb, for: asset)
    let loader = ThumbnailLoader()
    let beforeRemoval = await loader.load(for: asset)
    XCTAssertEqual(beforeRemoval, stale)

    try fm.removeItem(at: sidecar)
    let afterRemoval = await loader.load(for: asset)
    XCTAssertNotNil(afterRemoval)
    XCTAssertNotEqual(
      afterRemoval, stale, "the scoped retry must regenerate, not re-stamp old bytes")
    XCTAssertEqual(try Data(contentsOf: thumb), afterRemoval)
    XCTAssertTrue(LocalDerivativeSourceStamp.isFresh(thumb, for: asset))
  }

  func testLoadRejectsCorruptAssetRelativeCachedDerivative() async throws {
    let fm = FileManager.default
    let folder = fm.temporaryDirectory.appendingPathComponent("corrupt-thumb-\(UUID().uuidString)")
    try fm.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: folder) }
    let asset = folder.appendingPathComponent("unreadable.png")
    try Data([1, 2, 3]).write(to: asset)
    let cached = MapleSidecarPaths.thumbURL(for: asset)
    try fm.createDirectory(
      at: cached.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data([0xFF, 0xD8, 0x42, 0x99]).write(to: cached)
    let result = await ThumbnailLoader.shared.load(for: asset)
    XCTAssertNil(result)
  }
}
