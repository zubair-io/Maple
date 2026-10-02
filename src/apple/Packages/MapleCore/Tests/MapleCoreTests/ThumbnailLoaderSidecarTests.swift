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

    let got = await ThumbnailLoader.shared.load(for: panoURL)
    XCTAssertEqual(got, expected)

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
