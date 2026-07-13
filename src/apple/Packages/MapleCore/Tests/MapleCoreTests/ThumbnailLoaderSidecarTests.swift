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
        try fm.createDirectory(at: openFolder, withIntermediateDirectories: true)
        try fm.createDirectory(at: panoFolder, withIntermediateDirectories: true)
        await ThumbnailDiskCache.shared.configure(folderURL: openFolder)

        // Write a canonical asset-relative thumb next to the pano.
        let panoURL = panoFolder.appendingPathComponent("panorama-test.png")
        try Data([1, 2, 3, 4, 5]).write(to: panoURL)  // stand-in pano bytes
        let thumbURL = MapleSidecarPaths.thumbURL(for: panoURL)
        try fm.createDirectory(
            at: thumbURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let expected = Data([0xFF, 0xD8, 0x42, 0x99])  // arbitrary bytes — format-agnostic read
        try expected.write(to: thumbURL)

        let got = await ThumbnailLoader.shared.load(for: panoURL)
        XCTAssertEqual(got, expected)

        try? fm.removeItem(at: base)
    }
}
