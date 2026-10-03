import CoreGraphics
import CoreImage
import Foundation
import MapleAgentWire
import XCTest

@testable import MapleCore

@MainActor
final class AgentScopeColorTests: XCTestCase {
  private func model() -> AdjustmentModel {
    var model = AdjustmentModel.default
    model.sharpenAmount = 0
    model.nrColor = 0
    return model
  }

  func testPairedROICropsCoverageAtTopLeftAlongWithColorPixels() throws {
    let width = 100
    let height = 100
    var colors = [UInt8](repeating: 255, count: width * height * 4)
    var weights = [Float](repeating: 0, count: width * height)
    for y in 0..<height {
      for x in 0..<width {
        let i = y * width + x
        let selected = y >= 50 && x < 50
        colors[i * 4] = selected ? 200 : 20
        colors[i * 4 + 1] = selected ? 145 : 200
        colors[i * 4 + 2] = selected ? 115 : 230
        weights[i] = selected ? 1 : 0
      }
    }
    let canvas = CIImage(
      bitmapData: Data(colors), bytesPerRow: width * 4,
      size: CGSize(width: width, height: height), format: .RGBA8,
      colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
    let coverage = CIImage(
      bitmapData: weights.withUnsafeBufferPointer { Data(buffer: $0) }, bytesPerRow: width * 4,
      size: CGSize(width: width, height: height), format: .Rf, colorSpace: nil)
    let context = CIContext()
    let selected = try AgentInspector.Region.parse(
      .object(["x": 0, "y": 0, "width": 0.5, "height": 0.5]))
    let excluded = try AgentInspector.Region.parse(
      .object(["x": 0.5, "y": 0, "width": 0.5, "height": 0.5]))
    let a = try AgentVectorscope.capturePixels(
      canvas: canvas, weights: coverage, region: selected, context: context)
    let b = try AgentVectorscope.capturePixels(
      canvas: canvas, weights: coverage, region: excluded, context: context)
    let wanted = try AgentVectorscope.reduce(
      rgba: a.rgba, width: a.width, height: a.height, weighted: true)
    let empty = try AgentVectorscope.reduce(
      rgba: b.rgba, width: b.width, height: b.height, weighted: true)
    XCTAssertEqual(wanted.sample_count, 2500)
    XCTAssertEqual(wanted.confidence, 3)
    XCTAssertEqual(empty.sample_count, 0)
  }
  func testRealSkinRangeExcludesNonSkinAndMatchesRequestedROI() async throws {
    try await assertRealSkinRange(format: "jpg")
    try await assertRealSkinRange(format: "png")
  }

  private func assertRealSkinRange(format: String) async throws {
    let root = try SidecarContractIO.makeTempDirectory(prefix: "agent-scope-range")
    defer { try? FileManager.default.removeItem(at: root) }
    let url = root.appendingPathComponent("portrait.\(format)")
    let colors: [UInt8] = (0..<64 * 48).flatMap { i in
      i % 64 < 32 ? [217, 153, 115, 255] : [13, 204, 230, 255]
    }
    let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
    let image = CIImage(
      bitmapData: Data(colors), bytesPerRow: 64 * 4,
      size: CGSize(width: 64, height: 48), format: .RGBA8, colorSpace: space)
    if format == "png" {
      try CIContext().writePNGRepresentation(of: image, to: url, format: .RGBA8, colorSpace: space)
    } else {
      try CIContext().writeJPEGRepresentation(of: image, to: url, colorSpace: space)
    }
    let original = try Data(contentsOf: url)
    let session = EditSession(asset: AssetRef(url: url), model: model(), culling: CullingState())
    session.previewSize = CGSize(width: 64, height: 48)
    await session.openAssetPipelineAsync()
    _ = await session.latestRenderSchedule?.value
    let service = AgentEditService()
    service.activate(session)
    let state = try await service.handle(
      AgentRequest(id: 1, tool: "maple_get_active_photo", arguments: [:])
    )
    .outcome.get().result
    let revision = try XCTUnwrap(state["revision"]?.stringValue)
    let created = try await service.handle(
      AgentRequest(
        id: 2, tool: "maple_create_mask",
        arguments: [
          "kind": "whole_image_skin", "expected_revision": .string(revision),
        ])
    ).outcome.get().result
    let maskID = try XCTUnwrap(created["mask_id"]?.stringValue)
    let all = try await service.handle(
      AgentRequest(
        id: 3, tool: "maple_get_vectorscope",
        arguments: ["mask_id": .string(maskID)])
    ).outcome.get().result
    XCTAssertEqual(
      all["sample_count"]?.numberValue, 32 * 48,
      "Canonical skin refinement must reject cyan; geometry alone selects the whole frame.")
    XCTAssertEqual(all["confidence"]?.stringValue, "high")
    let background = try await service.handle(
      AgentRequest(
        id: 4, tool: "maple_get_vectorscope",
        arguments: [
          "mask_id": .string(maskID),
          "region": .object(["x": 0.5, "y": 0, "width": 0.5, "height": 1]),
        ])
    ).outcome.get().result
    XCTAssertEqual(background["sample_count"]?.numberValue, 0)
    XCTAssertEqual(background["insufficient_evidence"]?.boolValue, true)
    XCTAssertNil(background["skin_locus_angle_deg"])
    session.model.crop = Crop(top: 0.25, left: 0.25, bottom: 0.75, right: 0.75, angle: 0)
    session._scheduleRender(phase: .fast)
    _ = await session.latestRenderSchedule?.value
    await session.renderActor.awaitCurrentRenderIfInFlight()
    let cropped = try await session.agentScopePixels(maskID: UUID(uuidString: maskID), region: nil)
    XCTAssertEqual(cropped.width, 32)
    XCTAssertEqual(cropped.height, 24)
    let croppedEvidence = try AgentVectorscope.reduce(
      rgba: cropped.rgba, width: cropped.width, height: cropped.height, weighted: true)
    XCTAssertEqual(croppedEvidence.sample_count, 16 * 24)
    let croppedBackground = try await session.agentScopePixels(
      maskID: UUID(uuidString: maskID),
      region: AgentInspector.Region.parse(.object(["x": 0.5, "y": 0, "width": 0.5, "height": 1])))
    let croppedEmpty = try AgentVectorscope.reduce(
      rgba: croppedBackground.rgba, width: croppedBackground.width,
      height: croppedBackground.height, weighted: true)
    XCTAssertEqual(croppedEmpty.sample_count, 0)
    XCTAssertEqual(try Data(contentsOf: url), original)
  }

}
