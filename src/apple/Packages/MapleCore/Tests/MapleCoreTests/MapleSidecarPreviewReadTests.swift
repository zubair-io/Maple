import CoreImage
import XCTest

@testable import MapleCore

final class MapleSidecarPreviewReadTests: XCTestCase {
    func testReadMapleSidecarPreviewDecodesAVIFAtCanonicalPath() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent(
            "mspr-\(UUID().uuidString)/Panoramas")
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let panoURL = dir.appendingPathComponent("panorama-test.png")

        // Encode a real 8x4 AVIF at the canonical `<filename>.avif` path.
        let ci = CIImage(color: .gray).cropped(to: CGRect(x: 0, y: 0, width: 8, height: 4))
        let previewURL = MapleSidecarPaths.previewURL(for: panoURL)
        XCTAssertTrue(previewURL.lastPathComponent == "panorama-test.png.avif")
        try fm.createDirectory(
            at: previewURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let avif = try XCTUnwrap(ThumbnailEncoder.encode(ci, ctx: CIContext()))
        try avif.write(to: previewURL)

        // No `.v` version marker exists (#2009) — the reader must not require one.
        let decoded = EditSession.readMapleSidecarPreview(from: panoURL)
        XCTAssertNotNil(decoded)
        XCTAssertEqual(decoded?.extent.width, 8)

        // Missing file → nil.
        let missing = dir.appendingPathComponent("panorama-absent.png")
        XCTAssertNil(EditSession.readMapleSidecarPreview(from: missing))

        try? fm.removeItem(at: dir.deletingLastPathComponent())
    }
}
