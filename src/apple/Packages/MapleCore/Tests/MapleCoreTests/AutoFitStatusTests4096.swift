import CoreImage
import XCTest

@testable import MapleCore

extension EditSessionFilmLutSyncTests {
  @MainActor
  func testAutoFitStatusRejectsOldImageAndProfileReplies() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let session = EditSession(asset: AssetRef(url: dir.appendingPathComponent("first.dng")))
    XCTAssertEqual(session.autoFitStatus, .pending)
    let first = session.asset.id
    let revision = session.autoFitRevision
    session.publishAutoFit(true, assetID: first, profile: .auto, revision: revision)
    XCTAssertEqual(session.autoFitStatus, .active)
    session.model.profile = .neutral
    XCTAssertEqual(
      session.autoFitStatus.description(profile: .neutral),
      "Neutral uses a fixed base rendering.")
    session.model.profile = .auto
    session.publishAutoFit(true, assetID: first, profile: .auto, revision: revision)
    XCTAssertEqual(
      session.autoFitStatus, .pending, "Auto → Neutral → Auto invalidates an old reply")
    session.publishAutoFit(false, assetID: first, profile: .auto, revision: session.autoFitRevision)
    XCTAssertEqual(session.autoFitStatus, .unavailable)
    session.asset = AssetRef(url: dir.appendingPathComponent("second.dng"))
    session.publishAutoFit(true, assetID: first, profile: .auto, revision: session.autoFitRevision)
    XCTAssertEqual(session.autoFitStatus, .pending)
    _ = await session.latestRenderSchedule?.value
    await session.renderActor.awaitCurrentRenderIfInFlight()
    await session.flushPendingSidecarWrite()
    await session.renderActor.cancelAll()
    await session.releaseTransientMemory()
    let reopened = EditSession(asset: session.asset)
    XCTAssertEqual(reopened.autoFitStatus, .pending, "A reopened image must await its own fit")
    XCTAssertEqual(
      AutoFitStatus.unavailable.description(profile: .auto),
      "Auto matching is unavailable for this image.")
    XCTAssertEqual(
      AutoFitStatus.pending.description(profile: .auto), "Checking Auto matching for this image…")
    XCTAssertEqual(
      AutoFitStatus.active.description(profile: .auto),
      "Color and contrast matched to this image’s embedded camera preview.")
  }

}

extension AutoProfileCanvasParityTests {
  @MainActor
  func testActualAutoFitOutcomeWithAndWithoutEmbeddedPreview() async throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent()
    let noPreview = root.appendingPathComponent(
      "MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
    let physical = Self.fixtureDir("test-fixtures/raws").appendingPathComponent("test_0006.DNG")
    XCTAssertTrue(FileManager.default.fileExists(atPath: noPreview.path))
    guard FileManager.default.fileExists(atPath: physical.path) else {
      XCTFail("The explicit Auto-fit qualification requires test_0006.DNG")
      return
    }
    let physicalUnavailable = Self.fixtureDir("test-fixtures/raws").appendingPathComponent(
      "test_0018.dng")
    XCTAssertTrue(FileManager.default.fileExists(atPath: physicalUnavailable.path))
    let lut = AutoProfileLUT()
    let active = await lut.filter(forRawAt: physical, profile: .auto, quality: .preview)
    XCTAssertNotNil(active)
    let unavailable = await lut.filter(forRawAt: noPreview, profile: .auto, quality: .preview)
    XCTAssertNil(unavailable)
    let physicalAbsent = await lut.filter(
      forRawAt: physicalUnavailable, profile: .auto, quality: .preview)
    XCTAssertNil(physicalAbsent)
    let gpu = try GpuLiveSession(pixels: [0.18, 0.18, 0.18, 1], width: 1, height: 1)
    let gpuActive = await gpu.fitAutoProfile(rawPath: physical.path, quality: .preview)
    XCTAssertTrue(gpuActive)
    let gpuUnavailable = await gpu.fitAutoProfile(rawPath: noPreview.path, quality: .preview)
    XCTAssertFalse(gpuUnavailable)
    let gpuPhysicalAbsent = await gpu.fitAutoProfile(
      rawPath: physicalUnavailable.path, quality: .preview)
    XCTAssertFalse(gpuPhysicalAbsent)
    await gpu.close()
    let driver = GpuLiveDriver()
    try await driver.open(
      width: 1, height: 1,
      identity: GpuUploadIdentity(decodeGeneration: 1, crop: .identity)
    ) { [0.18, 0.18, 0.18, 1] }
    async let first = driver.fitAutoProfileIfNeeded(
      rawPath: physical.path, model: .default, quality: .preview)
    async let second = driver.fitAutoProfileIfNeeded(
      rawPath: physical.path, model: .default, quality: .preview)
    let outcomes = await [first, second]
    XCTAssertEqual(
      outcomes, [true, true], "Concurrent renders must join the same fit, including its outcome")
    await driver.closeSession()
    try await driver.open(
      width: 1, height: 1,
      identity: GpuUploadIdentity(decodeGeneration: 2, crop: .identity)
    ) { [0.18, 0.18, 0.18, 1] }
    let reopenedOutcome = await driver.fitAutoProfileIfNeeded(
      rawPath: noPreview.path, model: .default, quality: .preview)
    XCTAssertEqual(
      reopenedOutcome, false, "A reopened GPU session must not reuse the previous image’s status")
    await driver.closeSession()
    let staged = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: staged, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: staged) }
    for (source, expected) in [
      (physical, AutoFitStatus.active), (noPreview, .unavailable),
      (physicalUnavailable, .unavailable),
    ] {
      let url = staged.appendingPathComponent(source.lastPathComponent)
      try FileManager.default.copyItem(at: source, to: url)
      let session = EditSession(asset: AssetRef(url: url))
      await session.decodeAndRender(targetSize: CGSize(width: 128, height: 128), phase: .fast)
      XCTAssertNil(session.renderError)
      XCTAssertNotNil(session.renderedPreview)
      XCTAssertEqual(
        session.autoFitStatus, expected, "Actual CPU frame publication carries the fit outcome")
      let renderedModel = session.model
      let renderedRevision = session.autoFitRevision
      let frame = session.renderedPreview
      let writer = XMPSidecarStore(rawURL: url)
      await writer.update(model: renderedModel, culling: session.culling)
      await writer.flush()
      let persisted = try await XMPSidecarStore(rawURL: url).load()
      XCTAssertEqual(persisted.0, renderedModel, "The real XMP must describe the rendered model")
      session.renderRequested = true
      await session.loadSidecar()
      XCTAssertEqual(session.model, renderedModel)
      XCTAssertTrue(
        session.renderedPreview === frame, "Unchanged hydration retains the actual frame")
      XCTAssertEqual(session.autoFitRevision, renderedRevision)
      XCTAssertEqual(
        session.autoFitStatus, expected, "Unchanged XMP must retain the achieved frame's status")
      XCTAssertNil(
        session.latestRenderSchedule, "Unchanged hydration schedules no replacement frame")
      await session.releaseTransientMemory()
    }
    let broken = EditSession(
      asset: AssetRef(
        url: noPreview.deletingLastPathComponent().appendingPathComponent("missing.dng")))
    await broken.decodeAndRender(targetSize: CGSize(width: 128, height: 128), phase: .fast)
    XCTAssertNotNil(broken.renderError)
    XCTAssertEqual(
      broken.autoFitStatus, .unavailable, "A completed decode error must not remain pending")

  }
}
