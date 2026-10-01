import CoreGraphics
import Foundation
import ImageIO
import XCTest

@testable import MapleCore

final class NativeSavedRemovalSessionTests: XCTestCase {
  private func url(_ name: String, _ ext: String) throws -> URL {
    try XCTUnwrap(
      Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "removal/calibration"))
  }

  private func data(_ name: String, _ ext: String) throws -> Data {
    try Data(contentsOf: url(name, ext))
  }

  private func fixture() throws -> (NativeSavedRemovalSession, Data, String, [String: Data]) {
    let source = try data("source", "dng")
    let handle = try PipelineRenderer.openRawHandle(rawPath: url("source", "dng"))
    let mask = try data("mask", "mimf")
    let patch = try data("patch", "f16")
    let assets = [
      String(try RemovalBridge.digest(mask).dropFirst(7)) + ".mask": mask,
      String(try RemovalBridge.digest(patch).dropFirst(7)) + ".f16": patch,
    ]
    return (
      NativeSavedRemovalSession(handle: handle), source,
      String(decoding: try data("saved", "xmp"), as: UTF8.self), assets
    )
  }

  func testReopenAndLosslessExportMatchSharedPixelsWithoutInference() async throws {
    let (session, source, xmp, assets) = try fixture()
    let review = try await session.prepare(source: source, ext: "dng", xmp: xmp, assets: assets)
    XCTAssertEqual(review, [])
    for cap: UInt32 in [4, 64] {
      let preview = try await session.preview(xmp: xmp, maxLongEdge: cap)
      XCTAssertEqual(preview.width, cap == 4 ? 4 : 16)
      XCTAssertEqual(preview.height, cap == 4 ? 2 : 8)
      XCTAssertEqual(preview.bytes, try data("preview-\(cap)", "rgb"))
      let options = """
        {"format":"png","quality":100,"color_space":"srgb","max_long_edge":\(cap)}
        """
      let export = try await session.export(xmp: xmp, optionsJSON: options)
      XCTAssertEqual(export.width, preview.width)
      XCTAssertEqual(export.height, preview.height)
      let imageSource = try XCTUnwrap(CGImageSourceCreateWithData(export.bytes as CFData, nil))
      let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(imageSource, 0, nil))
      XCTAssertEqual(image.width, Int(preview.width))
      XCTAssertEqual(image.height, Int(preview.height))
      var rgba = [UInt8](repeating: 0, count: image.width * image.height * 4)
      try rgba.withUnsafeMutableBytes { buffer in
        let context = try XCTUnwrap(
          CGContext(
            data: buffer.baseAddress, width: image.width, height: image.height,
            bitsPerComponent: 8, bytesPerRow: image.width * 4,
            space: try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB)),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
      }
      let rgb = Data(rgba.enumerated().compactMap { $0.offset % 4 == 3 ? nil : $0.element })
      XCTAssertEqual(rgb, preview.bytes)
    }
    XCTAssertEqual(source, try data("source", "dng"))
  }

  func testCorruptPreparationClearsPreviousOwnerAndCanRecover() async throws {
    let (session, source, xmp, assets) = try fixture()
    _ = try await session.prepare(source: source, ext: "dng", xmp: xmp, assets: assets)
    var corrupt = assets
    let name = try XCTUnwrap(assets.keys.sorted().first)
    corrupt[name]![0] ^= 1
    do {
      _ = try await session.prepare(source: source, ext: "dng", xmp: xmp, assets: corrupt)
      XCTFail("Corrupt companion must fail")
    } catch { XCTAssertTrue(error is RemovalError) }
    do {
      _ = try await session.preview(xmp: xmp, maxLongEdge: 4)
      XCTFail("Previous prepared stack must have been cleared")
    } catch { XCTAssertTrue(error is RemovalError) }
    _ = try await session.prepare(source: source, ext: "dng", xmp: xmp, assets: assets)
    let recovered = try await session.preview(xmp: xmp, maxLongEdge: 4)
    XCTAssertEqual(recovered.bytes, try data("preview-4", "rgb"))
  }

  func testChangedSourceAndRecordsCannotPublishOrExport() async throws {
    let (session, source, xmp, assets) = try fixture()
    var changed = source
    changed[0] ^= 1
    do {
      _ = try await session.prepare(source: changed, ext: "dng", xmp: xmp, assets: assets)
      XCTFail("Different original must fail")
    } catch { XCTAssertTrue(error is RemovalError) }
    _ = try await session.prepare(source: source, ext: "dng", xmp: xmp, assets: assets)
    let changedXMP = "<rdf:Description xmlns:rdf=\"x\"/>"
    do {
      _ = try await session.preview(xmp: changedXMP, maxLongEdge: 4)
      XCTFail("Changed records must fail")
    } catch { XCTAssertTrue(error is RemovalError) }
    do {
      _ = try await session.export(
        xmp: changedXMP,
        optionsJSON:
          "{\"format\":\"png\",\"quality\":100,\"color_space\":\"srgb\",\"max_long_edge\":4}")
      XCTFail("Changed records must block export")
    } catch { XCTAssertTrue(error is RemovalError) }
    await session.reset()
    do {
      _ = try await session.preview(xmp: xmp, maxLongEdge: 4)
      XCTFail("Reset must invalidate the prepared stack")
    } catch { XCTAssertTrue(error is RemovalError) }
  }
}
