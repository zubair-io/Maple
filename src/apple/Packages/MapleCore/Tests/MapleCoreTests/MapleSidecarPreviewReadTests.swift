import CoreImage
import XCTest

@testable import MapleCore

final class MapleSidecarPreviewReadTests: XCTestCase {
    func testReadMapleSidecarPreviewDecodesJPEGAtCanonicalPath() throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent(
            "mspr-\(UUID().uuidString)/Panoramas")
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let panoURL = dir.appendingPathComponent("panorama-test.png")

        // Encode a real 8x4 JPEG at the canonical preview path.
        let ci = CIImage(color: .gray).cropped(to: CGRect(x: 0, y: 0, width: 8, height: 4))
        let previewURL = MapleSidecarPaths.previewURL(for: panoURL)
        try fm.createDirectory(
            at: previewURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let jpeg = CIContext().jpegRepresentation(
            of: ci, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, options: [:])!
        try jpeg.write(to: previewURL)

        let decoded = EditSession.readMapleSidecarPreview(from: panoURL)
        XCTAssertNotNil(decoded)
        XCTAssertEqual(decoded?.extent.width, 8)

        // Missing file → nil.
        let missing = dir.appendingPathComponent("panorama-absent.png")
        XCTAssertNil(EditSession.readMapleSidecarPreview(from: missing))

        try? fm.removeItem(at: dir.deletingLastPathComponent())
    }
}
