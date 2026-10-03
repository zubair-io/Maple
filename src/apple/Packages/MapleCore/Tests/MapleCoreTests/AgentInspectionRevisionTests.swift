import CoreImage
import Foundation
import MapleAgentWire
import XCTest

@testable import MapleCore

/// A real lazy Core Image source fences the detached rasterization itself.
/// No timer or production hook decides when the edit/photo switch happens.
@MainActor
final class AgentInspectionRevisionTests: XCTestCase {
  func testManualEditDuringInspectionDiscardsTheOldImageAndMetrics() async throws {
    try await inspectWhileChanging { _, session in
      session.beginEdit(description: "Manual contrast")
      session.model.contrast = 20
      session.endEdit()
    }
  }

  func testPhotoSwitchDuringInspectionDiscardsTheOldImageAndMetrics() async throws {
    let next = makeSession("next.dng")
    try await inspectWhileChanging { service, _ in service.activate(next) }
  }

  func testManualEditDuringVectorscopeDiscardsTheOldMetrics() async throws {
    try await inspectWhileChanging(tool: "maple_get_vectorscope") { _, session in
      session.beginEdit(description: "Manual contrast")
      session.model.contrast = 20
      session.endEdit()
    }
  }

  func testPhotoSwitchDuringVectorscopeDiscardsTheOldMetrics() async throws {
    let next = makeSession("next.dng")
    try await inspectWhileChanging(tool: "maple_get_vectorscope") { service, _ in
      service.activate(next)
    }
  }

  func testManualEditDuringMaskOverlayDiscardsTheOldImage() async throws {
    try await inspectWhileChanging(tool: "maple_render_mask_overlay") { _, session in
      session.beginEdit(description: "Manual contrast")
      session.model.contrast = 20
      session.endEdit()
    }
  }

  func testPhotoSwitchDuringMaskOverlayDiscardsTheOldImage() async throws {
    let next = makeSession("next.dng")
    try await inspectWhileChanging(tool: "maple_render_mask_overlay") { service, _ in
      service.activate(next)
    }
  }

  func testManualEditDuringPersonDetectionDoesNotCommitAMask() async throws {
    try await createPersonWhileChanging { _, session in
      session.beginEdit(description: "Manual contrast")
      session.model.contrast = 20
      session.endEdit()
    }
  }

  func testPhotoSwitchDuringPersonDetectionDoesNotCommitAMask() async throws {
    let next = makeSession("next.dng")
    try await createPersonWhileChanging { service, _ in service.activate(next) }
    XCTAssertTrue(next.model.localAdjustments.isEmpty)
    XCTAssertTrue(next.undoHistory.isEmpty)
  }

  func testPersonMaskDoesNotOpenATransactionBeforeFinalRasterValidation() async throws {
    let fixture = try XCTUnwrap(
      Bundle.module.url(forResource: "portrait-skin-test", withExtension: "png"))
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "agent-person-rejected")
    defer { try? FileManager.default.removeItem(at: directory) }
    let original = directory.appendingPathComponent("portrait.png")
    try FileManager.default.copyItem(at: fixture, to: original)
    let originalBytes = try Data(contentsOf: original)
    let session = EditSession(
      asset: AssetRef(url: original), model: .default, culling: CullingState())
    var validations = 0
    do {
      _ = try await AgentMaskService.createMask(["kind": "person_skin"], in: session) {
        validations += 1
        XCTAssertTrue(session.model.localAdjustments.isEmpty)
        XCTAssertTrue(session.undoHistory.isEmpty)
        XCTAssertNil(session.transactions.pending)
        if validations == 2 {
          session.beginEdit(description: "Manual contrast")
          session.model.contrast = 20
          session.endEdit()
          throw AgentError(code: "stale_revision", message: "Final revision rejected")
        }
      }
      XCTFail("The rejected completed raster was committed")
    } catch let error as AgentError {
      XCTAssertEqual(error.code, "stale_revision")
    }
    XCTAssertEqual(validations, 2, "Detection and the completed raster both need validation")
    XCTAssertEqual(session.model.contrast, 20)
    XCTAssertTrue(session.model.localAdjustments.isEmpty)
    XCTAssertEqual(session.undoHistory.count, 1)
    XCTAssertEqual(session.undoHistory.first?.description, "Manual contrast")
    await session.flushPendingSidecarWrite()
    let reopened = EditSession(
      asset: AssetRef(url: original), model: .default, culling: CullingState())
    await reopened.loadSidecar()
    XCTAssertEqual(reopened.model.contrast, 20)
    XCTAssertTrue(reopened.model.localAdjustments.isEmpty)
    XCTAssertEqual(try Data(contentsOf: original), originalBytes)
  }

  func testPersonMaskIsOneUndoAndPersistsToRealSidecarWithoutChangingOriginal() async throws {
    let fixture = try XCTUnwrap(
      Bundle.module.url(forResource: "portrait-skin-test", withExtension: "png"))
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "agent-person-mask")
    defer { try? FileManager.default.removeItem(at: directory) }
    let original = directory.appendingPathComponent("portrait.png")
    try FileManager.default.copyItem(at: fixture, to: original)
    let originalBytes = try Data(contentsOf: original)
    let session = EditSession(
      asset: AssetRef(url: original), model: .default, culling: CullingState())
    let service = AgentEditService()
    service.activate(session)
    let response = await service.handle(
      AgentRequest(
        id: 1, tool: "maple_create_mask",
        arguments: [
          "kind": "person_skin",
          "expected_revision": .string(AgentEditService.revision(of: session)),
        ]))
    let payload = try response.outcome.get()
    XCTAssertNotNil(payload.result["mask_id"]?.stringValue)
    XCTAssertEqual(session.model.localAdjustments.count, 1)
    XCTAssertEqual(session.undoHistory.count, 1)
    let layer = try XCTUnwrap(session.model.localAdjustments.first)
    await session.flushPendingSidecarWrite()
    let reopened = EditSession(
      asset: AssetRef(url: original), model: .default, culling: CullingState())
    await reopened.loadSidecar()
    XCTAssertEqual(reopened.model.localAdjustments.count, 1)
    guard case .bitmap(let expectedRecipe, _) = layer.mask,
      case .bitmap(let reopenedRecipe, let rasterId) = reopened.model.localAdjustments.first?.mask
    else { return XCTFail("The real sidecar did not reopen the person-mask recipe") }
    XCTAssertEqual(reopenedRecipe, expectedRecipe)
    XCTAssertGreaterThan(rasterId, 0, "The reopened recipe did not rehydrate its actual raster")
    XCTAssertEqual(reopened.model.localAdjustments.first?.range, .skinTone)
    session.undo()
    XCTAssertTrue(session.model.localAdjustments.isEmpty)
    await session.flushPendingSidecarWrite()
    let undone = EditSession(
      asset: AssetRef(url: original), model: .default, culling: CullingState())
    await undone.loadSidecar()
    XCTAssertTrue(undone.model.localAdjustments.isEmpty)
    XCTAssertEqual(try Data(contentsOf: original), originalBytes)
  }

  private func createPersonWhileChanging(
    _ change: (AgentEditService, EditSession) -> Void
  ) async throws {
    let url = try XCTUnwrap(
      Bundle.module.url(forResource: "portrait-skin-test", withExtension: "png"))
    let bytes = try Data(contentsOf: url)
    let started = expectation(description: "Actual segmentation source read")
    let source = FencedPortraitBytes(bytes: bytes, started: started)
    let session = EditSession(
      asset: AssetRef(displayName: "portrait.png", hintExtension: "png") { await source.read() },
      model: .default, culling: CullingState())
    let service = AgentEditService()
    service.activate(session)
    let revision = AgentEditService.revision(of: session)
    let response = Task {
      await service.handle(
        AgentRequest(
          id: 1, tool: "maple_create_mask",
          arguments: [
            "kind": "person_skin", "expected_revision": .string(revision),
          ]))
    }
    await fulfillment(of: [started], timeout: 10)
    change(service, session)
    let historyCount = session.undoHistory.count
    await source.release()
    let result = await response.value
    guard case .failure(let error) = result.outcome else {
      return XCTFail("Person detection committed a mask after the editor changed")
    }
    XCTAssertEqual(error.code, "stale_revision")
    XCTAssertTrue(session.model.localAdjustments.isEmpty)
    XCTAssertEqual(session.undoHistory.count, historyCount)
  }

  private func makeSession(_ name: String = "first.dng") -> EditSession {
    EditSession(
      asset: AssetRef(displayName: name, hintExtension: "dng") { Data() },
      model: .default, culling: CullingState())
  }

  private func inspectWhileChanging(
    tool: String = "maple_render_and_inspect",
    _ change: (AgentEditService, EditSession) -> Void
  ) async throws {
    let fixture = try XCTUnwrap(
      Bundle.module.url(forResource: "portrait-skin-test", withExtension: "png"))
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "agent-inspection-revision")
    defer { try? FileManager.default.removeItem(at: directory) }
    let original = directory.appendingPathComponent("portrait.png")
    try FileManager.default.copyItem(at: fixture, to: original)
    let originalBytes = try Data(contentsOf: original)
    let session = EditSession(asset: AssetRef(url: original))
    session.previewSize = CGSize(width: 256, height: 256)
    await session.openAssetPipelineAsync()
    if tool == "maple_render_mask_overlay" { session.createWholeImageSkinMask() }
    await session.flushPendingSidecarWrite()
    _ = await session.latestRenderSchedule?.value
    await session.renderActor.awaitCurrentRenderIfInFlight()
    let preview = try XCTUnwrap(session.renderedPreview)
    let context = await session.pipeline.context
    let source = FencedAgentImageProvider(image: preview, context: context)
    session.renderedPreview = CIImage(
      imageProvider: source, size: source.width, source.height,
      format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB), options: nil)
    let service = AgentEditService()
    service.activate(session)
    let response = Task {
      await service.handle(
        AgentRequest(
          id: 1, tool: tool,
          arguments: ["max_edge": 256]))
    }
    let started = await Task.detached {
      source.started.wait(timeout: .now() + 10) == .success
    }.value
    defer { source.resume.signal() }
    guard started else {
      source.resume.signal()
      _ = await response.value
      return XCTFail("The actual detached rasterizer did not request the lazy image")
    }
    // The service has passed its snapshot/revision check and is suspended
    // awaiting its detached inspector; this mutation is now deterministic.
    change(service, session)
    source.resume.signal()
    let result = await response.value
    guard case .failure(let error) = result.outcome else {
      return XCTFail("Inspection returned stale image/metrics after the editor changed")
    }
    XCTAssertEqual(error.code, "render_superseded")
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(try Data(contentsOf: original), originalBytes)
  }
}

private final class FencedAgentImageProvider: NSObject, @unchecked Sendable {
  let started = DispatchSemaphore(value: 0)
  let resume = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var firstDraw = true
  let width: Int
  let height: Int
  private let pixels: [UInt8]

  init(image: CIImage, context: CIContext) {
    width = Int(image.extent.width)
    height = Int(image.extent.height)
    var captured = [UInt8](repeating: 0, count: width * height * 4)
    context.render(
      image, toBitmap: &captured, rowBytes: width * 4, bounds: image.extent,
      format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
    pixels = captured
    super.init()
  }

  override func provideImageData(
    _ data: UnsafeMutableRawPointer, bytesPerRow: Int, origin x: Int, _ y: Int,
    size width: Int, _ height: Int, userInfo: Any?
  ) {
    let first = lock.withLock {
      let first = firstDraw
      firstDraw = false
      return first
    }
    if first {
      started.signal()
      _ = resume.wait(timeout: .now() + 15)
    }
    data.initializeMemory(as: UInt8.self, repeating: 0, count: bytesPerRow * height)
    pixels.withUnsafeBytes { source in
      guard let base = source.baseAddress else { return }
      for row in 0..<height {
        let sourceY = y + row
        guard sourceY >= 0, sourceY < self.height else { continue }
        let startX = max(0, x)
        let endX = min(self.width, x + width)
        guard endX > startX else { continue }
        data.advanced(by: row * bytesPerRow + (startX - x) * 4).copyMemory(
          from: base.advanced(by: (sourceY * self.width + startX) * 4),
          byteCount: (endX - startX) * 4)
      }
    }
  }
}

private actor FencedPortraitBytes {
  let bytes: Data
  let started: XCTestExpectation
  private var continuation: CheckedContinuation<Void, Never>?
  init(bytes: Data, started: XCTestExpectation) {
    self.bytes = bytes
    self.started = started
  }
  func read() async -> Data {
    await withCheckedContinuation { continuation in
      self.continuation = continuation
      started.fulfill()
    }
    return bytes
  }
  func release() {
    continuation?.resume()
    continuation = nil
  }
}
