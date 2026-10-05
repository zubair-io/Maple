// AgentMaskScopeTests — Milestone 3 vectorscope and mask tool contracts:
// Rec.709 chroma math, resultant vector angle, skin locus gating,
// insufficient evidence threshold (<50 samples), mask creation (linear, radial,
// skin range), local slider mutations, and translucent red overlay rendering.

import CoreGraphics
import CoreImage
import MapleAgentWire
import XCTest

@testable import MapleCore

@MainActor
final class AgentMaskScopeTests: XCTestCase {
  private func makeSession() -> EditSession {
    let session = EditSession(
      asset: AssetRef(displayName: "portrait.dng", hintExtension: "dng") { Data() },
      model: .default, culling: CullingState())
    // Provide a synthetic 200x200 canvas preview (warm skin tone)
    let skinColor = CIColor(red: 0.85, green: 0.60, blue: 0.50)
    session.renderedPreview = CIImage(color: skinColor).cropped(
      to: CGRect(x: 0, y: 0, width: 200, height: 200))
    return session
  }

  private func call(
    _ service: AgentEditService, _ tool: String, _ arguments: [String: JSONValue] = [:]
  ) async -> Result<AgentPayload, AgentError> {
    await service.handle(AgentRequest(id: 1, tool: tool, arguments: arguments)).outcome
  }

  private func revision(_ service: AgentEditService) async throws -> String {
    let state = try await call(service, "maple_get_active_photo").get().result
    return try XCTUnwrap(state["revision"]?.stringValue)
  }

  func testNonStringAdjustmentMaskIDCannotFallBackToGlobalEdits() async throws {
    try await assertNonStringMaskIDsAreRejected(tool: "maple_set_adjustments")
  }

  func testNonStringOverlayMaskIDCannotFallBackToSelectedMask() async throws {
    try await assertNonStringMaskIDsAreRejected(tool: "maple_render_mask_overlay")
  }

  private func assertNonStringMaskIDsAreRejected(tool: String) async throws {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "agent-mask-id-type")
    defer { try? FileManager.default.removeItem(at: directory) }
    let fixture = try XCTUnwrap(
      Bundle.module.url(forResource: "portrait-skin-test", withExtension: "png"))
    let original = directory.appendingPathComponent("portrait.png")
    try FileManager.default.copyItem(at: fixture, to: original)
    let bytes = try Data(contentsOf: original)
    let session = EditSession(asset: AssetRef(url: original))
    session.previewSize = CGSize(width: 200, height: 200)
    await session.openAssetPipelineAsync()
    _ = await session.latestRenderSchedule?.value
    let service = AgentEditService()
    service.activate(session)
    let created = try await call(
      service, "maple_create_mask",
      ["expected_revision": .string(try await revision(service)), "kind": "radial"]
    ).get().result
    let maskID = try XCTUnwrap(created["mask_id"]?.stringValue)
    await session.flushPendingSidecarWrite()
    let sidecar = SidecarPath.sidecarURL(for: original)
    let savedXML = try Data(contentsOf: sidecar)
    let initialModel = session.model
    let initialRevision = try await revision(service)
    let initialHistoryCount = session.undoHistory.count

    for invalid: JSONValue in [.number(1), .null, .bool(false), .array([]), .object([:])] {
      let response = await call(
        service, tool,
        [
          "mask_id": invalid, "expected_revision": .string(initialRevision),
          "adjustments": ["exposure": 0.5], "max_edge": 256,
        ])
      if case .failure(let error) = response {
        XCTAssertEqual(error.code, "invalid_arguments", "\(tool): \(invalid)")
      } else {
        XCTFail("A supplied non-string mask ID fell back to another target: \(tool), \(invalid)")
      }
      XCTAssertEqual(session.model, initialModel)
      XCTAssertEqual(session.undoHistory.count, initialHistoryCount)
      XCTAssertEqual(session.selectedMaskId?.uuidString, maskID)
      let currentRevision = try await revision(service)
      XCTAssertEqual(currentRevision, initialRevision)
      await session.flushPendingSidecarWrite()
      XCTAssertEqual(try Data(contentsOf: sidecar), savedXML)
      XCTAssertEqual(try Data(contentsOf: original), bytes)
    }

    // Omission retains the documented default; an explicit UUID still targets the mask.
    let omitted = try await call(
      service, tool,
      ["expected_revision": .string(initialRevision), "adjustments": ["exposure": 0.5]]
    ).get()
    if tool == "maple_set_adjustments" {
      XCTAssertEqual(session.model.exposure, 0.5)
      XCTAssertEqual(session.model.localAdjustments, initialModel.localAdjustments)
    } else {
      XCTAssertEqual(omitted.result["mask_id"]?.stringValue, maskID)
      XCTAssertNotNil(omitted.image)
    }
    let targeted = try await call(
      service, tool,
      [
        "mask_id": .string(maskID), "expected_revision": .string(try await revision(service)),
        "adjustments": ["exposure": 0.6], "max_edge": 256,
      ]
    ).get()
    XCTAssertEqual(targeted.result["mask_id"]?.stringValue, maskID)
    if tool == "maple_set_adjustments" {
      XCTAssertEqual(session.model.exposure, 0.5)
      XCTAssertEqual(session.model.localAdjustments.first?.adjustments.exposure, 0.6)
    }
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(try Data(contentsOf: original), bytes)
  }

  func testUndoClearsRemovedMaskSelectionAndRedoPreservesValidSelection() async throws {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "agent-mask-undo")
    defer { try? FileManager.default.removeItem(at: directory) }
    let fixture = try XCTUnwrap(
      Bundle.module.url(forResource: "portrait-skin-test", withExtension: "png"))
    let original = directory.appendingPathComponent("portrait.png")
    try FileManager.default.copyItem(at: fixture, to: original)
    let bytes = try Data(contentsOf: original)
    let session = EditSession(asset: AssetRef(url: original))
    let service = AgentEditService()
    service.activate(session)
    let initial = session.model
    let initialRevision = try await revision(service)
    let created = try await call(
      service, "maple_create_mask",
      [
        "expected_revision": .string(initialRevision), "kind": "radial",
        "params": ["center": ["x": 0.5, "y": 0.5], "radii": ["x": 0.3, "y": 0.3]],
      ]
    ).get().result
    let maskID = try XCTUnwrap(UUID(uuidString: try XCTUnwrap(created["mask_id"]?.stringValue)))
    let edited = session.model
    XCTAssertEqual(session.selectedMaskId, maskID)
    session.undo()
    XCTAssertEqual(session.model, initial)
    XCTAssertNil(session.selectedMaskId)
    XCTAssertFalse(session.showsMaskOverlay)
    let restoredState = try await call(service, "maple_get_active_photo").get().result
    XCTAssertNil(restoredState["selected_mask_id"])
    let restoredRevision = try await revision(service)
    XCTAssertEqual(restoredRevision, initialRevision)
    session.redo()
    XCTAssertEqual(session.model, edited)
    XCTAssertNil(session.selectedMaskId, "Redo restores the model without inventing a selection")
    session.selectedMaskId = maskID
    session.beginEdit()
    session.model.exposure = 0.25
    session.endEdit()
    session.undo()
    XCTAssertEqual(session.selectedMaskId, maskID, "Undo retains a mask that still exists")
    session.redo()
    XCTAssertEqual(session.selectedMaskId, maskID)
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(try Data(contentsOf: original), bytes)
  }

  func testChromaRec709Math() {
    // Pure red (1, 0, 0)
    let red = AgentVectorscope.compute(
      rgba: [255, 0, 0, 255], width: 1, height: 1, hasSkinTarget: false)
    let (redCb, redCr) = (red.meanCb, red.meanCr)
    XCTAssertEqual(redCb, -0.114572, accuracy: 0.0001)
    XCTAssertEqual(redCr, 0.5, accuracy: 0.0001)

    // Pure green (0, 1, 0)
    let green = AgentVectorscope.compute(
      rgba: [0, 255, 0, 255], width: 1, height: 1, hasSkinTarget: false)
    let (greenCb, greenCr) = (green.meanCb, green.meanCr)
    XCTAssertEqual(greenCb, -0.385428, accuracy: 0.0001)
    XCTAssertEqual(greenCr, -0.454153, accuracy: 0.0001)

    // Pure blue (0, 0, 1)
    let blue = AgentVectorscope.compute(
      rgba: [0, 0, 255, 255], width: 1, height: 1, hasSkinTarget: false)
    let (blueCb, blueCr) = (blue.meanCb, blue.meanCr)
    XCTAssertEqual(blueCb, 0.5, accuracy: 0.0001)
    XCTAssertEqual(blueCr, -0.045847, accuracy: 0.0001)
  }

  func testVectorscopeAchromaticAndInsufficientEvidence() {
    // All white (255, 255, 255) — achromatic
    let white = [UInt8](repeating: 255, count: 100 * 4)
    let resultWhite = AgentVectorscope.compute(
      rgba: white, width: 10, height: 10, hasSkinTarget: true)
    XCTAssertEqual(resultWhite.sampleCount, 0)
    XCTAssertTrue(resultWhite.insufficientEvidence)
    XCTAssertEqual(resultWhite.confidence, "insufficient")
    XCTAssertNil(resultWhite.skinLocusAngleDeg)
    XCTAssertNotNil(resultWhite.warning)

    // 30 skin tone pixels (< 50 sample threshold)
    var sparseRgba = [UInt8](repeating: 255, count: 100 * 4)
    for i in 0..<30 {
      sparseRgba[i * 4] = 215
      sparseRgba[i * 4 + 1] = 150
      sparseRgba[i * 4 + 2] = 120
      sparseRgba[i * 4 + 3] = 255
    }
    let resultSparse = AgentVectorscope.compute(
      rgba: sparseRgba, width: 10, height: 10, hasSkinTarget: true)
    XCTAssertEqual(resultSparse.sampleCount, 30)
    XCTAssertTrue(resultSparse.insufficientEvidence)
    XCTAssertNil(resultSparse.skinLocusAngleDeg)
    XCTAssertTrue(resultSparse.warning?.contains("Fewer than 50") == true)
  }

  func testVectorscopeWithoutSkinTargetSuppressesLocus() {
    // Abundant chromatic samples (e.g. 400 pixels of blue/cyan)
    var cyanRgba = [UInt8]()
    for _ in 0..<400 {
      cyanRgba += [20, 180, 220, 255]
    }
    let result = AgentVectorscope.compute(
      rgba: cyanRgba, width: 20, height: 20, hasSkinTarget: false)
    XCTAssertEqual(result.sampleCount, 400)
    XCTAssertFalse(result.insufficientEvidence)
    XCTAssertNil(
      result.skinLocusAngleDeg, "Whole-image without skin target must not claim a skin locus")
    XCTAssertNil(result.deviationDeg)
    XCTAssertTrue(result.warning?.contains("Whole-image vectorscope without a skin mask") == true)
  }

  func testVectorscopeWithSkinTargetComputesLocusAndDeviation() {
    // 400 pixels of standard warm skin tone: r=215, g=155, b=125
    var skinRgba = [UInt8]()
    for _ in 0..<400 {
      skinRgba += [215, 155, 125, 255]
    }
    let result = AgentVectorscope.compute(
      rgba: skinRgba, width: 20, height: 20, hasSkinTarget: true)
    XCTAssertEqual(result.sampleCount, 400)
    XCTAssertFalse(result.insufficientEvidence)
    XCTAssertNotNil(result.skinLocusAngleDeg)
    guard let angle = result.skinLocusAngleDeg else { return XCTFail("expected angle") }
    // Rec.709 skin angle is around 120°..126°
    XCTAssertGreaterThan(angle, 115.0)
    XCTAssertLessThan(angle, 130.0)
    XCTAssertNotNil(result.deviationDeg)
    XCTAssertEqual(result.confidence, "high")
    XCTAssertNil(result.warning)
  }

  func testUnsafePersonIndexIsRejectedBeforeVisionWithoutMutatingMasks() async throws {
    let service = AgentEditService()
    let session = makeSession()
    service.activate(session)
    let initialRevision = try await revision(service)
    for invalid in ["1e100", "-1e100", "9223372036854775808", "1.5", "null", "true", "\"5\"", "-1"]
    {
      let json = """
        {"id":1,"tool":"maple_create_mask","arguments":{
        "expected_revision":"\(initialRevision)","kind":"person_skin",
        "params":{"person_index":\(invalid)}}}
        """
      let fields = try JSONValue.decode(Data(json.utf8))
      let request = AgentRequest(
        id: 1,
        tool: try XCTUnwrap(fields["tool"]?.stringValue),
        arguments: try XCTUnwrap(fields["arguments"]?.objectValue))
      guard case .failure(let error) = await service.handle(request).outcome else {
        XCTFail("Accepted person_index=\(invalid)")
        continue
      }
      XCTAssertEqual(error.code, "invalid_arguments", "person_index=\(invalid)")
      XCTAssertTrue(session.model.localAdjustments.isEmpty)
      let afterRevision = try await revision(service)
      XCTAssertEqual(afterRevision, initialRevision)
    }
  }

  func testCreateGeometricLinearAndRadialMasks() async throws {
    let service = AgentEditService()
    let session = makeSession()
    service.activate(session)

    // Linear mask
    let linearResult = try await call(
      service, "maple_create_mask",
      [
        "expected_revision": .string(try await revision(service)),
        "kind": "linear",
        "params": [
          "start": ["x": 0.2, "y": 0.1],
          "end": ["x": 0.8, "y": 0.9],
          "feather": 0.6,
        ],
        "description": "Linear sky gradient",
      ]
    ).get().result

    let linearId = try XCTUnwrap(linearResult["mask_id"]?.stringValue)
    XCTAssertEqual(linearResult["kind"], "linear")
    XCTAssertEqual(session.model.localAdjustments.count, 1)
    XCTAssertEqual(session.selectedMaskId?.uuidString, linearId)
    if case .linear(let start, let end, let feather) = session.model.localAdjustments[0].mask {
      XCTAssertEqual(start.x, 0.2)
      XCTAssertEqual(start.y, 0.1)
      XCTAssertEqual(end.x, 0.8)
      XCTAssertEqual(end.y, 0.9)
      XCTAssertEqual(feather, 0.6)
    } else {
      XCTFail("expected linear mask geometry")
    }

    // Radial mask
    let radialResult = try await call(
      service, "maple_create_mask",
      [
        "expected_revision": .string(try await revision(service)),
        "kind": "radial",
        "params": [
          "center": ["x": 0.5, "y": 0.5],
          "radii": ["x": 0.3, "y": 0.3],
          "angle": 15.0,
          "feather": 0.4,
          "invert": true,
        ],
      ]
    ).get().result

    let radialId = try XCTUnwrap(radialResult["mask_id"]?.stringValue)
    XCTAssertEqual(radialResult["kind"], "radial")
    XCTAssertEqual(session.model.localAdjustments.count, 2)
    XCTAssertEqual(session.selectedMaskId?.uuidString, radialId)
  }

  func testCreateWholeImageSkinMask() async throws {
    let service = AgentEditService()
    let session = makeSession()
    service.activate(session)

    let result = try await call(
      service, "maple_create_mask",
      [
        "expected_revision": .string(try await revision(service)),
        "kind": "whole_image_skin",
      ]
    ).get().result

    let maskId = try XCTUnwrap(result["mask_id"]?.stringValue)
    XCTAssertEqual(result["kind"], "whole_image_skin")
    XCTAssertEqual(session.model.localAdjustments.count, 1)
    let layer = session.model.localAdjustments[0]
    XCTAssertEqual(layer.id.uuidString, maskId)
    XCTAssertEqual(layer.range, .skinTone)
    XCTAssertEqual(layer.mask, .everywhere)
  }

  func testAdjustMaskLocally() async throws {
    let service = AgentEditService()
    let session = makeSession()
    service.activate(session)

    // Create a mask first
    let maskRes = try await call(
      service, "maple_create_mask",
      ["expected_revision": .string(try await revision(service)), "kind": "whole_image_skin"]
    ).get().result
    let maskId = try XCTUnwrap(maskRes["mask_id"]?.stringValue)

    // Adjust local sliders on the mask
    let adjustRes = try await call(
      service, "maple_set_adjustments",
      [
        "expected_revision": .string(try await revision(service)),
        "mask_id": .string(maskId),
        "adjustments": [
          "exposure": 0.6,
          "tint": -15.0,
          "texture": 30.0,
        ],
        "description": "Warm skin local adjust",
      ]
    ).get().result

    XCTAssertEqual(adjustRes["applied"]?["exposure"], 0.6)
    XCTAssertEqual(adjustRes["applied"]?["tint"], -15.0)
    XCTAssertEqual(adjustRes["applied"]?["texture"], 30.0)

    let layer = try XCTUnwrap(session.model.localAdjustments.first)
    XCTAssertEqual(layer.adjustments.exposure, 0.6)
    XCTAssertEqual(layer.adjustments.tint, -15.0)
    XCTAssertEqual(layer.adjustments.texture, 30.0)
    // Global exposure should remain neutral (0)
    XCTAssertEqual(session.model.exposure, 0.0)

    // Out-of-range local slider is rejected
    let badRes = await call(
      service, "maple_set_adjustments",
      [
        "expected_revision": .string(try await revision(service)),
        "mask_id": .string(maskId),
        "adjustments": ["exposure": 12.0],
      ]
    )
    guard case .failure(let err) = badRes else { return XCTFail("expected failure") }
    XCTAssertEqual(err.code, "invalid_arguments")
  }

  func testRenderMaskOverlay() async throws {
    let service = AgentEditService()
    let root = try SidecarContractIO.makeTempDirectory(prefix: "agent-overlay-real-mask")
    defer { try? FileManager.default.removeItem(at: root) }
    let url = root.appendingPathComponent("portrait.png")
    let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
    let image = CIImage(color: CIColor(red: 0.85, green: 0.60, blue: 0.45)).cropped(
      to: CGRect(x: 0, y: 0, width: 200, height: 200))
    try CIContext().writePNGRepresentation(of: image, to: url, format: .RGBA8, colorSpace: space)
    let original = try Data(contentsOf: url)
    let session = EditSession(asset: AssetRef(url: url))
    session.previewSize = CGSize(width: 200, height: 200)
    await session.openAssetPipelineAsync()
    _ = await session.latestRenderSchedule?.value
    await session.renderActor.awaitCurrentRenderIfInFlight()
    service.activate(session)

    // Create radial mask
    let maskRes = try await call(
      service, "maple_create_mask",
      ["expected_revision": .string(try await revision(service)), "kind": "radial"]
    ).get().result
    let maskId = try XCTUnwrap(maskRes["mask_id"]?.stringValue)

    let overlayRes = try await call(
      service, "maple_render_mask_overlay",
      ["mask_id": .string(maskId), "max_edge": 256]
    ).get()

    XCTAssertEqual(overlayRes.result["mask_id"]?.stringValue, maskId)
    XCTAssertEqual(overlayRes.result["kind"]?.stringValue, "radial")
    XCTAssertNotNil(overlayRes.result["coverage_pct"])
    XCTAssertNotNil(overlayRes.result["sample_count"])
    XCTAssertEqual(overlayRes.image?.mimeType, "image/jpeg")
    XCTAssertEqual(overlayRes.image?.data.prefix(2), Data([0xFF, 0xD8]))
    XCTAssertEqual(try Data(contentsOf: url), original)

    // Whole image skin mask uses range refinement
    let skinMaskRes = try await call(
      service, "maple_create_mask",
      ["expected_revision": .string(try await revision(service)), "kind": "whole_image_skin"]
    ).get().result
    let skinMaskId = try XCTUnwrap(skinMaskRes["mask_id"]?.stringValue)

    let skinOverlayRes = try await call(
      service, "maple_render_mask_overlay",
      ["mask_id": .string(skinMaskId), "max_edge": 256]
    ).get()

    XCTAssertEqual(skinOverlayRes.result["mask_id"]?.stringValue, skinMaskId)
    XCTAssertEqual(skinOverlayRes.result["kind"]?.stringValue, "whole_image_skin")
    XCTAssertNotNil(skinOverlayRes.result["coverage_pct"])
    XCTAssertEqual(skinOverlayRes.image?.mimeType, "image/jpeg")

    // Cropped session reflects cropped dimensions in overlay
    session.beginEdit(kind: .crop, description: "Crop")
    session.model.crop = Crop(top: 0, left: 0, bottom: 1, right: 0.5)
    session.endEdit()
    _ = await session.latestRenderSchedule?.value
    await session.renderActor.awaitCurrentRenderIfInFlight()

    let croppedOverlayRes = try await call(
      service, "maple_render_mask_overlay",
      ["mask_id": .string(maskId), "max_edge": 256]
    ).get()
    let w = try XCTUnwrap(croppedOverlayRes.result["width"]?.numberValue)
    let h = try XCTUnwrap(croppedOverlayRes.result["height"]?.numberValue)
    XCTAssertTrue(w < h, "Cropped width (\(w)) should be smaller than height (\(h))")
  }

  func testGetVectorscopeToolWithMask() async throws {
    let service = AgentEditService()
    let root = try SidecarContractIO.makeTempDirectory(prefix: "agent-scope-real-mask")
    defer { try? FileManager.default.removeItem(at: root) }
    let url = root.appendingPathComponent("portrait.jpg")
    let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
    let image = CIImage(color: CIColor(red: 0.85, green: 0.60, blue: 0.45)).cropped(
      to: CGRect(x: 0, y: 0, width: 200, height: 200))
    try CIContext().writeJPEGRepresentation(of: image, to: url, colorSpace: space)
    let session = EditSession(asset: AssetRef(url: url))
    session.previewSize = CGSize(width: 200, height: 200)
    await session.openAssetPipelineAsync()
    _ = await session.latestRenderSchedule?.value
    service.activate(session)

    // Create a whole-image skin mask
    let maskRes = try await call(
      service, "maple_create_mask",
      ["expected_revision": .string(try await revision(service)), "kind": "whole_image_skin"]
    ).get().result
    let maskId = try XCTUnwrap(maskRes["mask_id"]?.stringValue)

    let scopeRes = try await call(
      service, "maple_get_vectorscope",
      ["mask_id": .string(maskId)]
    ).get().result

    XCTAssertEqual(scopeRes["basis"]?.stringValue, "Rec.709 display-referred sRGB")
    XCTAssertEqual(scopeRes["target_hint_deg"]?.numberValue, 123.0)
    XCTAssertEqual(scopeRes["target_wedge_deg"]?.numberValue, 10.0)
    XCTAssertEqual(scopeRes["has_skin_target"]?.boolValue, true)
    XCTAssertEqual(scopeRes["mask_id"]?.stringValue, maskId)
    XCTAssertEqual(scopeRes["insufficient_evidence"]?.boolValue, false)
    XCTAssertNotNil(scopeRes["skin_locus_angle_deg"])
    XCTAssertNotNil(scopeRes["deviation_deg"])
    XCTAssertNotNil(scopeRes["confidence"])
  }
}
