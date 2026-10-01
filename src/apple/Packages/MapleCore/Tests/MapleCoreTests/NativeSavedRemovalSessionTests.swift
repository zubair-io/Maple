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

  func testNativeDetailMatchesFullSavedPixelsAcrossPansAndExposureChanges() async throws {
    let (session, source, savedXMP, assets) = try fixture()
    _ = try await session.prepare(source: source, ext: "dng", xmp: savedXMP, assets: assets)
    for exposure in [-2, 1, 0] {
      let xmp = savedXMP.replacingOccurrences(
        of: "papp:InpaintRemovals=",
        with:
          "xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\" crs:Exposure2012=\"\(exposure)\" papp:InpaintRemovals="
      )
      let full = try await session.preview(xmp: xmp, maxLongEdge: 64)
      for x: UInt32 in [0, 4, 8, 0] {
        let detail = try await session.detail(
          xmp: xmp, x: x, y: 2, width: 8, height: 4, baseLongEdge: 64)
        XCTAssertEqual(detail.width, 8)
        XCTAssertEqual(detail.height, 4)
        let expected = Data(
          (2..<6).flatMap { y -> [UInt8] in
            let start = (y * Int(full.width) + Int(x)) * 3
            return Array(full.bytes[start..<(start + 8 * 3)])
          })
        XCTAssertEqual(detail.bytes, expected)
      }
    }
    do {
      _ = try await session.detail(
        xmp: savedXMP, x: 4, y: 2, width: 8, height: 4, baseLongEdge: 64,
        maxWorkingPixels: 1)
      XCTFail("Filter overlap must count toward the memory budget")
    } catch { XCTAssertTrue(error is RemovalError) }
    do {
      _ = try await session.detail(
        xmp: "<rdf:Description xmlns:rdf=\"x\"/>", x: 4, y: 2,
        width: 8, height: 4, baseLongEdge: 64)
      XCTFail("Changed accepted records cannot reuse retained anchors")
    } catch { XCTAssertTrue(error is RemovalError) }
    let recovered = try await session.detail(
      xmp: savedXMP, x: 4, y: 2, width: 8, height: 4, baseLongEdge: 64)
    XCTAssertEqual(recovered.bytes.count, 8 * 4 * 3)
    await session.reset()
    do {
      _ = try await session.detail(
        xmp: savedXMP, x: 4, y: 2, width: 8, height: 4, baseLongEdge: 64)
      XCTFail("Reset must retire native-detail anchors with their owner")
    } catch { XCTAssertTrue(error is RemovalError) }
  }
  func testOrdinaryNativeFileRendererAndFilmExportConsumeSavedCompanions() throws {
    let (_, source, xmp, assets) = try fixture()
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let raw = folder.appendingPathComponent("photo.dng")
    let sidecar = folder.appendingPathComponent("photo.xmp")
    let directory = folder.appendingPathComponent(".maple/inpaint", isDirectory: true)
    try source.write(to: raw)
    try Data(xmp.utf8).write(to: sidecar)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    for (name, data) in assets { try data.write(to: directory.appendingPathComponent(name)) }
    let expected = try data("preview-64", "rgb")
    let ordinary = try PipelineRenderer.render(rawPath: raw, xmpPath: sidecar, quality: .full)
    XCTAssertEqual(ordinary.pixels, expected)
    let film = try PipelineRenderer.render(
      rawPath: raw, xmpPath: sidecar, quality: .full, filmLut: nil)
    XCTAssertEqual(film.pixels, ordinary.pixels)
    let missing = try XCTUnwrap(assets.keys.sorted().first)
    try FileManager.default.removeItem(at: directory.appendingPathComponent(missing))
    XCTAssertThrowsError(
      try PipelineRenderer.render(rawPath: raw, xmpPath: sidecar, quality: .full)
    ) {
      guard case PipelineError.renderFailed(let code, _) = $0 else { return XCTFail("\($0)") }
      XCTAssertEqual(code, 8)
    }
    XCTAssertEqual(try Data(contentsOf: raw), source)
    XCTAssertEqual(try String(contentsOf: sidecar, encoding: .utf8), xmp)
  }

  func testSelectionProxyIncludesSavedPixelsAndExcludesCreativeGradeAndGeometry() async throws {
    let (session, source, xmp, assets) = try fixture()
    _ = try await session.prepare(source: source, ext: "dng", xmp: xmp, assets: assets)
    let proxy = try await session.selectionProxy(xmp: xmp)
    XCTAssertEqual(proxy.width, 16)
    XCTAssertEqual(proxy.height, 8)
    XCTAssertEqual(proxy.bytes.count, 384)
    let creative = xmp.replacingOccurrences(
      of: "papp:InpaintRemovals=",
      with: """
        xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="3" crs:Temperature="9000" crs:HasCrop="True" crs:CropLeft="0.25" crs:CropRight="0.75" crs:CropAngle="7" crs:PerspectiveX="50" papp:InpaintRemovals=
        """)
    let changed = try await session.selectionProxy(xmp: creative)
    XCTAssertEqual(changed.bytes, proxy.bytes)
    do {
      _ = try await session.selectionProxy(
        xmp: "<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"/>")
      XCTFail("Another saved stack cannot become a selection proxy")
    } catch { XCTAssertTrue(error is RemovalError) }
  }

}
