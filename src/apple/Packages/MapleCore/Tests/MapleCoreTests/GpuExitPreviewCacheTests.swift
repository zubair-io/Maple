import CoreImage
import QuartzCore
import XCTest

@testable import MapleCore

@MainActor
final class GpuExitPreviewCacheTests: XCTestCase {
  func testExitPersistsCurrentGpuFrameAfterImmediateTransactionAndSidecarFlush() async throws {
    let (session, url, original, layer) = try await makeSession()
    session.beginEdit(description: "Final exposure")
    session.model.exposure = 1.25
    session.model.contrast = 12
    session.culling.stars = 3
    // An older CPU fallback must not overwrite the current GPU image on exit.
    session.scheduleDisplayPreviewPersist(
      CIImage(color: .red).cropped(to: CGRect(x: 0, y: 0, width: 8, height: 8)))
    await session.persistDisplayPreviewOnExit()

    let parsed = try XMPParser.parse(data: Data(contentsOf: SidecarPath.sidecarURL(for: url)))
    XCTAssertEqual(parsed.0.exposure, 1.25)
    XCTAssertEqual(parsed.0.contrast, 12)
    XCTAssertEqual(parsed.1.stars, 3)
    XCTAssertEqual(session.undoHistory.count, 1)
    XCTAssertEqual(session.lastCommittedTransaction?.after, session.model)
    XCTAssertNil(session.pendingPreviewImage)
    XCTAssertEqual(try Data(contentsOf: url), original)

    // A fresh actor must retrieve the JPEG from disk under the final XMP mtime.
    let reopened = RenderedPreviewCache()
    await reopened.configure(folderURL: url.deletingLastPathComponent())
    let cached = await reopened.preview(for: url, screenWidth: 32)
    XCTAssertEqual(try XCTUnwrap(cached).extent.size, CGSize(width: 32, height: 32))
    let preview = try XCTUnwrap(CIImage(contentsOf: MapleSidecarPaths.previewURL(for: url)))
    XCTAssertEqual(
      preview.extent.size, CGSize(width: 32, height: 32), "Old 8px CPU frame must not win")
    let thumb = await ThumbnailDiskCache.shared.thumbnail(for: url)
    XCTAssertNotNil(thumb, "The existing browse thumbnail write must survive")
    withExtendedLifetime(layer) {}
  }

  func testExitRejectsUnappliedCropAndKeepsCpuPreviewFallback() async throws {
    let (session, url, original, layer) = try await makeSession()
    session.cropEditingActive = true
    session.beginEdit(kind: .crop, description: "Crop")
    session.model.crop = Crop(top: 0, left: 0.25, bottom: 1, right: 0.75)
    session.scheduleDisplayPreviewPersist(
      CIImage(color: .blue).cropped(to: CGRect(x: 0, y: 0, width: 16, height: 32)))
    await session.persistDisplayPreviewOnExit()

    let freshCache = RenderedPreviewCache()
    await freshCache.configure(folderURL: url.deletingLastPathComponent())
    let stale = await freshCache.preview(for: url, screenWidth: 32)
    XCTAssertNil(stale, "Uncropped uploaded pixels cannot use the newly cropped XMP key")
    let preview = try XCTUnwrap(CIImage(contentsOf: MapleSidecarPaths.previewURL(for: url)))
    XCTAssertEqual(preview.extent.size, CGSize(width: 16, height: 32), "Retain the CPU fallback")
    XCTAssertEqual(try Data(contentsOf: url), original)
    withExtendedLifetime(layer) {}
  }

  func testResumedEditDoesNotPopulateTheExitingModelsCacheOrPreview() async throws {
    let (session, url, original, layer) = try await makeSession()
    session.beginEdit(description: "Exiting edit")
    session.model.exposure = 0.5
    _ = await session.latestRenderSchedule?.value
    await session.renderActor.awaitCurrentRenderIfInFlight()
    let driver = try XCTUnwrap(session.gpuLiveDriver)
    let native = try XCTUnwrap(driver.session)
    let occupied = expectation(description: "GPU queue suspended")
    let release = DispatchSemaphore(value: 0)
    let blocked = Task.detached {
      await native.holdExitQueue(occupied: occupied, release: release)
    }
    await fulfillment(of: [occupied], timeout: 5)
    let exit = Task { @MainActor in await session.persistDisplayPreviewOnExit() }
    let deadline = ContinuousClock.now.advanced(by: .seconds(5))
    while session.lastCommittedTransaction == nil, ContinuousClock.now < deadline {
      await Task.yield()
    }
    XCTAssertEqual(session.lastCommittedTransaction?.after.exposure, 0.5)
    // The exit captured/committed A; edit B resumes while its GPU work waits.
    session.model.exposure = 2
    release.signal()
    await blocked.value
    await exit.value
    await session.flushPendingSidecarWrite()
    let cache = RenderedPreviewCache()
    await cache.configure(folderURL: url.deletingLastPathComponent())
    let cached = await cache.preview(for: url, screenWidth: 32)
    XCTAssertNil(cached)
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: MapleSidecarPaths.previewURL(for: url).path))
    XCTAssertEqual(try Data(contentsOf: url), original)
    withExtendedLifetime(layer) {}
  }

  private func makeSession() async throws -> (EditSession, URL, Data, CAMetalLayer) {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appendingPathComponent("original.png")
    let original = try SidecarContractIO.makeSyntheticOriginal(at: url)
    var model = AdjustmentModel.default
    model.profile = .neutral
    try XMPSerializer.serialize(model: model, culling: CullingState())
      .write(to: SidecarPath.sidecarURL(for: url), atomically: true, encoding: .utf8)
    await RenderedPreviewCache.shared.configure(folderURL: directory)
    await ThumbnailDiskCache.shared.configure(folderURL: directory)
    let session = EditSession(asset: AssetRef(url: url), model: model)
    let layer = CAMetalLayer()
    layer.bounds = CGRect(x: 0, y: 0, width: 32, height: 32)
    let driver = GpuLiveDriver()
    driver.register(layer: layer)
    session.gpuLiveDriver = driver
    session.nativeImageSize = CGSize(width: 32, height: 32)
    session.isResolvingFirstFrame = true
    session.previewSize = CGSize(width: 32, height: 32)
    addTeardownBlock {
      await session.flushPendingSidecarWrite()
      await session.renderActor.cancelAll()
      await driver.closeSession()
      try? FileManager.default.removeItem(at: directory)
      withExtendedLifetime(layer) {}
    }
    // Assigning the first viewport already starts the production scheduler.
    // Do not race it with a second, unowned direct decode/open.
    _ = await session.latestRenderSchedule?.value
    await session.renderActor.awaitCurrentRenderIfInFlight()
    XCTAssertTrue(session.gpuFramePresented, "Must exercise real GPU present, never CPU fallback")
    XCTAssertFalse(session.gpuPresentFailed)
    XCTAssertFalse(session.isResolvingFirstFrame)
    let initial = await RenderedPreviewCache.shared.preview(for: url, screenWidth: 32)
    XCTAssertNil(initial, "Cold-open readiness must not start a GPU cache readback")
    return (session, url, original, layer)
  }
}

extension GpuLiveSession {
  fileprivate func holdExitQueue(occupied: XCTestExpectation, release: DispatchSemaphore) {
    occupied.fulfill()
    XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
  }
}
