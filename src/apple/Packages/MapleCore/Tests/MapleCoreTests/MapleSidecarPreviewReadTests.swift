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
    try Data([1, 2, 3, 4, 5]).write(to: panoURL)

    // Encode a real 8x4 AVIF at the canonical `<filename>.avif` path.
    let ci = CIImage(color: .gray).cropped(to: CGRect(x: 0, y: 0, width: 8, height: 4))
    let previewURL = MapleSidecarPaths.previewURL(for: panoURL)
    XCTAssertTrue(
      previewURL.lastPathComponent
        == "panorama-test.png.avif")
    try fm.createDirectory(
      at: previewURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    let avif = try XCTUnwrap(ThumbnailEncoder.encode(ci, ctx: CIContext()))
    try avif.write(to: previewURL)
    LocalDerivativeSourceStamp.record(previewURL, for: panoURL)

    // No `.v` version marker exists (#2009) — the reader must not require one.
    let decoded = EditSession.readMapleSidecarPreview(from: panoURL)
    XCTAssertNotNil(decoded)
    XCTAssertEqual(decoded?.extent.width, 8)

    try Data([1, 2, 3, 4, 5, 6]).write(to: panoURL)
    XCTAssertNil(EditSession.readMapleSidecarPreview(from: panoURL), "a changed original")
    LocalDerivativeSourceStamp.record(previewURL, for: panoURL)
    XCTAssertNotNil(EditSession.readMapleSidecarPreview(from: panoURL))

    let xmpURL = SidecarPath.sidecarURL(for: panoURL)
    try Data("<x/>".utf8).write(to: xmpURL)
    XCTAssertNil(EditSession.readMapleSidecarPreview(from: panoURL), "an added sidecar")
    LocalDerivativeSourceStamp.record(previewURL, for: panoURL)
    XCTAssertNotNil(EditSession.readMapleSidecarPreview(from: panoURL))
    try fm.removeItem(at: xmpURL)
    XCTAssertNil(EditSession.readMapleSidecarPreview(from: panoURL), "a removed sidecar")

    // Missing file → nil.
    let missing = dir.appendingPathComponent("panorama-absent.png")
    XCTAssertNil(EditSession.readMapleSidecarPreview(from: missing))

    try? fm.removeItem(at: dir.deletingLastPathComponent())
  }
}
