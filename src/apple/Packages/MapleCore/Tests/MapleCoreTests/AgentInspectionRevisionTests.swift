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

  private func makeSession(_ name: String = "first.dng") -> EditSession {
    EditSession(
      asset: AssetRef(displayName: name, hintExtension: "dng") { Data() },
      model: .default, culling: CullingState())
  }

  private func inspectWhileChanging(
    _ change: (AgentEditService, EditSession) -> Void
  ) async throws {
    let source = FencedAgentImageProvider()
    let session = makeSession()
    session.renderedPreview = CIImage(
      imageProvider: source, size: 256, 256,
      format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB), options: nil)
    let service = AgentEditService()
    service.activate(session)
    let response = Task {
      await service.handle(
        AgentRequest(
          id: 1, tool: "maple_render_and_inspect",
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
  }
}

private final class FencedAgentImageProvider: NSObject, @unchecked Sendable {
  let started = DispatchSemaphore(value: 0)
  let resume = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var firstDraw = true

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
    data.initializeMemory(as: UInt8.self, repeating: 255, count: bytesPerRow * height)
  }
}
