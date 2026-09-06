import CoreImage
import Foundation
import XCTest

@testable import MapleCore

@MainActor
final class RenderActivityTests: XCTestCase {
  func testCancelledCPURefineAndFitShortcutSettleLoadingState() async throws {
    let fixture = try await makeFixture()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let session = fixture.session
    let held = await holdCPUPreviewSlot()
    defer { held.release.signal() }
    let obsolete = Task {
      await session.decodeAndRender(targetSize: CGSize(width: 48, height: 48), phase: .refine)
    }
    await waitForQueuedCount(1, on: session.renderActor)
    XCTAssertTrue(session.isRendering)
    obsolete.cancel()
    await obsolete.value
    XCTAssertFalse(session.isRendering, "A canceled CPU admission must release its loading state")

    // Fit refines skip decodeAndRender entirely. They must not rely on a
    // subsequent image publication to recover the canceled request's flag.
    XCTAssertEqual(session.fastTargetSize, session.refinedTargetSize)
    session._scheduleRefine()
    try await Task.sleep(for: .milliseconds(250))
    XCTAssertFalse(session.isRendering)
    held.release.signal()
    _ = try await held.task.value
  }

  func testCancelledOlderCPURequestCannotSettleNewerRequest() async throws {
    let fixture = try await makeFixture()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let session = fixture.session
    let held = await holdCPUPreviewSlot()
    defer { held.release.signal() }
    let obsolete = Task {
      await session.decodeAndRender(targetSize: CGSize(width: 32, height: 32), phase: .fast)
    }
    await waitForQueuedCount(1, on: session.renderActor)
    let current = Task {
      await session.decodeAndRender(targetSize: CGSize(width: 32, height: 32), phase: .fast)
    }
    await waitForQueuedCount(2, on: session.renderActor)
    obsolete.cancel()
    await obsolete.value
    XCTAssertTrue(session.isRendering, "The newer request still owns the loading indicator")

    held.release.signal()
    _ = try await held.task.value
    await current.value
    XCTAssertNotNil(session.renderedPreview, "The current request must still publish real pixels")
    XCTAssertNil(session.renderError)
    XCTAssertFalse(session.isRendering)
  }

  func testInvalidatingNativeDetailCannotSettleNewerCPURequest() async throws {
    let fixture = try await makeFixture()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let session = fixture.session
    // Seed native-detail's in-flight ownership, as its renderer does before
    // awaiting the native actor. Exercise the real invalidation method below.
    session.nativeDetailInFlightID = session.beginRenderActivity()
    let held = await holdCPUPreviewSlot()
    defer { held.release.signal() }
    let current = Task {
      await session.decodeAndRender(targetSize: CGSize(width: 32, height: 32), phase: .fast)
    }
    await waitForQueuedCount(1, on: session.renderActor)
    session.clearNativeDetailPreview()
    XCTAssertNil(session.nativeDetailInFlightID)
    XCTAssertTrue(session.isRendering, "Native-detail teardown must preserve the newer CPU owner")
    current.cancel()
    await current.value
    XCTAssertFalse(session.isRendering)
    held.release.signal()
    _ = try await held.task.value
  }

  private func makeFixture() async throws -> (directory: URL, session: EditSession) {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("maple-render-activity-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appendingPathComponent("fixture.png")
    let image = CIImage(color: CIColor(red: 0.4, green: 0.3, blue: 0.2))
      .cropped(to: CGRect(x: 0, y: 0, width: 64, height: 64))
    try CIContext().writePNGRepresentation(
      of: image, to: url, format: .RGBA8,
      colorSpace: try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB)))
    let session = EditSession(asset: AssetRef(url: url))
    session.gpuLiveDriver = nil
    session.nativeImageSize = CGSize(width: 64, height: 64)
    session.deepZoomState.previewSize = CGSize(width: 32, height: 32)
    let decoded = await session.pipeline.decodeSceneLinearNonRaw(
      asset: session.asset, targetSize: nil)
    await session.renderActor._testSeedDecodedCache(
      asset: session.asset, decoded: try XCTUnwrap(decoded),
      rawResolution: CGSize(width: 64, height: 64))
    return (directory, session)
  }

  private func holdCPUPreviewSlot() async -> (
    release: DispatchSemaphore, task: Task<CIImage, Error>
  ) {
    let renderer = RenderActor(pipeline: ImageEditPipeline())
    let entered = expectation(description: "CPU slot held")
    let release = DispatchSemaphore(value: 0)
    let task = Task {
      try await renderer.renderCPUPreview {
        entered.fulfill()
        XCTAssertEqual(release.wait(timeout: .now() + 10), .success)
        return CIImage.empty()
      }
    }
    await fulfillment(of: [entered], timeout: 5)
    return (release, task)
  }

  private func waitForQueuedCount(_ count: Int, on renderer: RenderActor) async {
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while await renderer._testCPUPreviewQueuedCount() != count {
      guard ContinuousClock.now < deadline else {
        XCTFail("Expected \(count) queued CPU renders before cancellation")
        return
      }
      try? await Task.sleep(for: .milliseconds(5))
    }
  }
}
