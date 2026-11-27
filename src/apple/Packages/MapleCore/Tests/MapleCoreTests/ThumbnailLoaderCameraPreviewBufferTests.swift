import Foundation
import RawPipeline
import XCTest

@testable import MapleCore

final class ThumbnailLoaderCameraPreviewBufferTests: XCTestCase {
  private let fm = FileManager.default
  private var root: URL!

  override func setUpWithError() throws {
    root = fm.temporaryDirectory.appendingPathComponent("camera-preview-buffer-\(UUID())")
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try fm.removeItem(at: root)
  }

  private func fixture(_ path: String) throws -> URL {
    let url = try XCTUnwrap(Bundle.module.resourceURL).appendingPathComponent(path)
    let staged = root.appendingPathComponent(url.lastPathComponent)
    try fm.copyItem(at: url, to: staged)
    return staged
  }

  private func bytesFromFileExtern(_ raw: URL) throws -> Data {
    let output = root.appendingPathComponent("oracle-\(UUID()).jpg")
    let result = raw.path.withCString { rawPath in
      output.path.withCString { outPath in
        maple_render_thumbnail_preview_jpeg_to_file(
          rawPath, outPath, UInt32(ThumbnailLoader.displayPreviewLongEdge), 85)
      }
    }
    XCTAssertEqual(result, 0)
    return try Data(contentsOf: output)
  }

  func testBufferPathReturnsTheBytesTheFilePathReturned() throws {
    let raw = try fixture("camera-preview/preview.dng")
    let expected = try bytesFromFileExtern(raw)
    XCTAssertGreaterThan(expected.count, 1_000)
    XCTAssertEqual(ThumbnailLoader.embeddedCameraJPEG(at: raw), expected)
  }

  func testPreviewLargerThanTheFirstBufferIsFetchedOnRetry() throws {
    let raw = try fixture("camera-preview/preview.dng")
    let expected = try bytesFromFileExtern(raw)
    XCTAssertGreaterThan(expected.count, 16)
    XCTAssertEqual(ThumbnailLoader.embeddedCameraJPEG(at: raw, initialCapacity: 16), expected)
  }

  func testRawWithoutEmbeddedPreviewReturnsNil() throws {
    let raw = try fixture("removal/source.dng")
    XCTAssertNil(ThumbnailLoader.embeddedCameraJPEG(at: raw))
  }

  func testMissingFileReturnsNil() {
    XCTAssertNil(ThumbnailLoader.embeddedCameraJPEG(at: root.appendingPathComponent("gone.dng")))
  }
}
