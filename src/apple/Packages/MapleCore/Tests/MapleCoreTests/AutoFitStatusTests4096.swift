import CoreImage
import XCTest

@testable import MapleCore

extension EditSessionFilmLutSyncTests {
  @MainActor
  func testAutoFitFailureRejectsStaleIdentityAndPreservesCompletedOutcomes() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let session = EditSession(asset: AssetRef(url: directory.appendingPathComponent("first.dng")))
    let first = session.asset.id
    let firstRevision = session.autoFitRevision
    session.asset = AssetRef(url: directory.appendingPathComponent("second.dng"))
    let current = session.asset.id
    let currentRevision = session.autoFitRevision
    session.settleAutoFitFailure(assetID: first, profile: .auto, revision: currentRevision)
    XCTAssertEqual(session.autoFitStatus, .pending, "An old asset cannot settle the current fit")
    session.settleAutoFitFailure(assetID: current, profile: .neutral, revision: currentRevision)
    XCTAssertEqual(session.autoFitStatus, .pending, "An old profile cannot settle the current fit")
    session.settleAutoFitFailure(assetID: current, profile: .auto, revision: firstRevision)
    XCTAssertEqual(session.autoFitStatus, .pending, "An old revision cannot settle the current fit")
    session.settleAutoFitFailure(assetID: current, profile: .auto, revision: currentRevision)
    XCTAssertEqual(session.autoFitStatus, .unavailable)
    session.publishAutoFit(true, assetID: current, profile: .auto, revision: currentRevision)
    XCTAssertEqual(session.autoFitStatus, .active, "A successful later fit may update the outcome")
    session.settleAutoFitFailure(assetID: current, profile: .auto, revision: currentRevision)
    XCTAssertEqual(session.autoFitStatus, .active)
    session.publishAutoFit(false, assetID: current, profile: .auto, revision: currentRevision)
    XCTAssertEqual(
      session.autoFitStatus, .unavailable, "An actual later fit result remains authoritative")
    session.settleAutoFitFailure(assetID: current, profile: .auto, revision: currentRevision)
    XCTAssertEqual(session.autoFitStatus, .unavailable)
    session.isHydratingInitialState = true
    session.model.profile = .neutral
    let neutralRevision = session.autoFitRevision
    session.settleAutoFitFailure(assetID: current, profile: .auto, revision: neutralRevision)
    XCTAssertEqual(
      session.autoFitStatus, .pending, "A current Neutral image has no Auto fit to settle")
    session.model.profile = .auto
    session.isHydratingInitialState = false
    session.settleAutoFitFailure(assetID: current, profile: .auto, revision: neutralRevision)
    XCTAssertEqual(session.autoFitStatus, .pending, "A profile round trip invalidates the failure")
    await session.releaseTransientMemory()
  }

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
  func testScalarRenderFailurePreservesCompletedAutoFit() async throws {
    let source = Self.fixtureDir("test-fixtures/raws").appendingPathComponent("test_0006.DNG")
    XCTAssertTrue(FileManager.default.fileExists(atPath: source.path))
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent(source.lastPathComponent)
    try FileManager.default.copyItem(at: source, to: url)
    let session = EditSession(asset: AssetRef(url: url))
    await session.decodeAndRender(targetSize: CGSize(width: 128, height: 128), phase: .fast)
    XCTAssertNil(session.renderError)
    XCTAssertEqual(session.autoFitStatus, .active, "The real embedded preview fit completed")
    let revision = session.autoFitRevision
    let assetID = session.asset.id
    await session.releaseTransientMemory()
    // Simulate an unavailable owned source after eviction, without altering the original RAW.
    try FileManager.default.removeItem(at: url)
    session.isHydratingInitialState = true
    session.model.exposure += 0.25
    session.isHydratingInitialState = false
    XCTAssertEqual(session.autoFitRevision, revision, "Scalar edits keep the fit identity")
    XCTAssertEqual(session.asset.id, assetID)
    await session.decodeAndRender(targetSize: CGSize(width: 128, height: 128), phase: .fast)
    XCTAssertNotNil(session.renderError, "The real missing-source decode must fail")
    XCTAssertEqual(session.autoFitRevision, revision)
    XCTAssertEqual(
      session.autoFitStatus, .active, "A render error does not disprove a completed fit")
    await session.releaseTransientMemory()
  }

  @MainActor
  func testPendingAutoFitDecodeFailureSettlesUnavailable() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("invalid.dng")
    try Data("not a RAW image".utf8).write(to: url)
    let session = EditSession(asset: AssetRef(url: url))
    XCTAssertEqual(session.autoFitStatus, .pending)
    await session.decodeAndRender(targetSize: CGSize(width: 128, height: 128), phase: .fast)
    XCTAssertNotNil(session.renderError)
    XCTAssertEqual(session.autoFitStatus, .unavailable)
    XCTAssertEqual(try Data(contentsOf: url), Data("not a RAW image".utf8))
    await session.releaseTransientMemory()
  }

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
