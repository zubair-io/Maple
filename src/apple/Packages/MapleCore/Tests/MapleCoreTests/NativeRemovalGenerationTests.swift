import Foundation
import XCTest

@testable import MapleCore

final class NativeRemovalGenerationTests: XCTestCase {
  private func sourceURL() throws -> URL {
    try XCTUnwrap(
      Bundle.module.url(
        forResource: "source", withExtension: "dng",
        subdirectory: "removal/calibration"))
  }

  private func preparation(modelDigest: String? = nil) async throws -> (
    NativeRemovalGeneration, Data, MapleRawHandle
  ) {
    let url = try sourceURL()
    let source = try Data(contentsOf: url)
    let handle = try PipelineRenderer.openRawHandle(rawPath: url)
    let anchor = try RemovalBridge.calibrationSource(handle: handle)
    let mask = try RemovalBridge.selection(
      width: 16, height: 8,
      request:
        "{\"schema\":1,\"strokes\":[{\"subtract\":false,\"radius\":0.06,\"points\":[[0.5,0.5]]}]}")
    let plan = try NativeRemovalGeneration.plan(
      source: anchor, intent: mask, holeRadius: 1,
      fringeRadius: 1)
    let request: [String: Any] = [
      "schema": 1,
      "source": try JSONSerialization.jsonObject(with: Data(anchor.utf8)),
      "masks": try JSONSerialization.jsonObject(with: Data(plan.utf8)),
      "model": try modelDigest ?? RemovalBridge.digest(Data("fixture".utf8)),
      "model_version": "fixture",
    ]
    let scene = try RemovalBridge.calibrationContext(
      handle: handle, x: 0, y: 0, width: 16, height: 8)
    let generation = try NativeRemovalGeneration.prepare(
      request: String(decoding: JSONSerialization.data(withJSONObject: request), as: UTF8.self),
      prior: "[]", scene: scene, intent: mask)
    return (generation, source, handle)
  }

  func testSharedPreparationProducesPortableSceneAssetsAndRefusesMalformedOutput() async throws {
    let (generation, source, handle) = try await preparation()
    let input = try generation.inputs()
    XCTAssertEqual(input.rgb.count, 3 * 1024 * 1024)
    XCTAssertEqual(input.hole.count, 1024 * 1024)
    XCTAssertTrue(input.rgb.allSatisfy { (0...1).contains($0) })
    let proposal = try generation.finish(generated: input.rgb)
    let records = try RemovalBridge.prepare(
      request: proposal.request, prior: "[]",
      mask: proposal.mask, patch: proposal.patch)
    let assets = [
      String(try RemovalBridge.digest(proposal.mask).dropFirst(7)) + ".mask": proposal.mask,
      String(try RemovalBridge.digest(proposal.patch).dropFirst(7)) + ".f16": proposal.patch,
    ]
    let xmp =
      "<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" papp:InpaintRemovals=\"\(records.replacingOccurrences(of: "\"", with: "&quot;"))\"/>"
    let session = NativeSavedRemovalSession(handle: handle)
    _ = try await session.prepare(source: source, ext: "dng", xmp: xmp, assets: assets)
    let context = try await session.generationContext(xmp: xmp, x: 0, y: 0, width: 16, height: 8)
    XCTAssertEqual(context.count, 16 * 8 * 3)
    let preview = try await session.preview(xmp: xmp, maxLongEdge: 16)
    XCTAssertEqual(preview.bytes.count, 16 * 8 * 3)
    XCTAssertEqual(source, try Data(contentsOf: sourceURL()))
    XCTAssertThrowsError(try generation.finish(generated: []))
    var invalid = input.rgb
    invalid[0] = .nan
    XCTAssertThrowsError(try generation.finish(generated: invalid))
    XCTAssertThrowsError(
      try NativeRemovalGeneration.plan(
        source: "\0", intent: proposal.mask,
        holeRadius: 1, fringeRadius: 1))
    do {
      _ = try await session.generationContext(
        xmp: "<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"/>",
        x: 0, y: 0, width: 16, height: 8)
      XCTFail("A different stack must not become a generation context")
    } catch { XCTAssertTrue(error is RemovalError) }
  }

  func testActualNativeReconstructionReturnsVerifiedCompanionsAndReopensWithoutModel() async throws
  {
    #if os(macOS)
      let root = (0..<7).reduce(URL(fileURLWithPath: #filePath)) { value, _ in
        value.deletingLastPathComponent()
      }
      .appendingPathComponent("test-fixtures/raws/removal-inference")
      guard
        FileManager.default.fileExists(
          atPath: root.appendingPathComponent("lama-native-1024.onnx").path),
        FileManager.default.fileExists(atPath: root.appendingPathComponent("runtime.dylib").path)
      else { throw XCTSkip("Local native removal model corpus is not installed (#3941)") }
      let model = try NativeRemovalReconstructor.open(
        directory: root, runtime: root.appendingPathComponent("runtime.dylib"))
      XCTAssertEqual(
        model.modelDigest,
        try RemovalBridge.digest(
          Data(
            contentsOf: root.appendingPathComponent("lama-native-1024.onnx"), options: .mappedIfSafe
          )))
      let wrongModel = try await preparation()
      XCTAssertThrowsError(try wrongModel.0.reconstruct(using: model, operation: model.operation()))
      {
        XCTAssertTrue($0 is RemovalError)
      }
      let (prepared, source, handle) = try await preparation(modelDigest: model.modelDigest)
      let proposal = try prepared.reconstruct(using: model, operation: model.operation())
      let records = try RemovalBridge.prepare(
        request: proposal.request, prior: "[]", mask: proposal.mask, patch: proposal.patch)
      let assets = [
        String(try RemovalBridge.digest(proposal.mask).dropFirst(7)) + ".mask": proposal.mask,
        String(try RemovalBridge.digest(proposal.patch).dropFirst(7)) + ".f16": proposal.patch,
      ]
      let xmp =
        "<rdf:Description xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" papp:InpaintRemovals=\"\(records.replacingOccurrences(of: "\"", with: "&quot;"))\"/>"
      let reopened = NativeSavedRemovalSession(handle: handle)
      _ = try await reopened.prepare(source: source, ext: "dng", xmp: xmp, assets: assets)
      let preview = try await reopened.preview(xmp: xmp, maxLongEdge: 16)
      XCTAssertEqual(preview.bytes.count, 384)
      XCTAssertEqual(source, try Data(contentsOf: sourceURL()))
      let cancelled = try model.operation()
      cancelled.cancel()
      XCTAssertThrowsError(try prepared.reconstruct(using: model, operation: cancelled)) {
        guard case PipelineError.cancelled = $0 else {
          return XCTFail("Expected cancellation, got \($0)")
        }
      }
    #else
      throw XCTSkip("Static iOS generation requires physical-device qualification (#3941)")
    #endif
  }
}
