import CoreImage
import Foundation
import XCTest

@testable import MapleCore

@MainActor
final class NativeAutoProfilePreparationTests: XCTestCase {
  private func fixtureURL(_ relativePath: String) -> URL {
    let stagedRoot = ProcessInfo.processInfo.environment["MAPLE_SWIFT_TEST_ROOT"]
      .map(URL.init(fileURLWithPath:))
    let stagedFixture = stagedRoot?.appendingPathComponent(relativePath)
    if let stagedFixture, FileManager.default.fileExists(atPath: stagedFixture.path) {
      return stagedFixture
    }
    return AutoProfileCanvasParityTests.fixtureDir(relativePath)
  }

  func testPendingNativeSourceDoesNotBlockReuseAndNewDecodeOrQualityReplacesItsRequest()
    async throws
  {
    let fixture = fixtureURL("test-fixtures/removal/basic/source.dng")
    let original = try Data(contentsOf: fixture)
    let gate = NativeAutoSourceGate()
    let started = expectation(description: "One owned source download entered")
    let asset = AssetRef(displayName: "source", hintExtension: "dng", explicitIsRaw: true) {
      started.fulfill()
      await gate.wait()
      return original
    }
    let session = EditSession(asset: asset)
    let driver = GpuLiveDriver()
    do {
      try await driver.open(
        width: 16, height: 16, identity: .init(decodeGeneration: 1, crop: .identity)
      ) { Array(repeating: Float(0.18), count: 16 * 16 * 4) }
      // A real provisional fit, including this fixture's valid absent tail.
      await driver.fitAutoProfileIfNeeded(rawPath: fixture.path, model: .default, quality: .preview)
      let quality: PipelineRenderer.Quality = AmazeFlag.isEnabled ? .amaze : .full
      let source = await session.renderActor.rawRenderSource
      var firstPublished = false
      XCTAssertNil(
        session.nativeAutoProfile.prepared(
          asset: session.asset, source: source, quality: quality, decodeGeneration: 1
        ) { firstPublished = true })
      await fulfillment(of: [started], timeout: 3)
      let reused = expectation(
        description: "Provisional GPU can continue while native source waits")
      var didReturn = false
      let attempt = Task {
        let current = await session.prepareGpuAutoProfile(
          driver: driver, model: .default, decodeGeneration: 1, quality: .preview, gen: nil)
        didReturn = true
        reused.fulfill()
        return current
      }
      await fulfillment(of: [reused], timeout: 1)
      let returnedBeforeSource = didReturn
      XCTAssertTrue(returnedBeforeSource)
      // Always release the provider if this regression fails, so XCTest does
      // not leave a task hanging after reporting the timeout.
      if !returnedBeforeSource {
        await gate.open()
        _ = await attempt.value
        await session.nativeAutoProfile.cancelAndWait()
        await driver.closeSession()
        return
      }
      let canContinue = await attempt.value
      XCTAssertTrue(canContinue)
      XCTAssertNil(session.nativeAutoProfile.ready)
      XCTAssertFalse(firstPublished)
      // A new decode must replace the pending request, despite a reusable GPU
      // fit. Both jobs still share the one owned source download.
      let replacement = await session.prepareGpuAutoProfile(
        driver: driver, model: .default, decodeGeneration: 2, quality: .preview, gen: nil)
      XCTAssertTrue(replacement)
      // A different quality on that same decode must also be replaced by the
      // actual Mac native quality, without another download or a stale result.
      var previewPublished = false
      XCTAssertNil(
        session.nativeAutoProfile.prepared(
          asset: session.asset, source: source, quality: .preview, decodeGeneration: 2
        ) { previewPublished = true })
      let corrected = await session.prepareGpuAutoProfile(
        driver: driver, model: .default, decodeGeneration: 2, quality: .preview, gen: nil)
      XCTAssertTrue(corrected)
      await gate.open()
      await session.nativeAutoProfile.awaitPreparation()
      let ready = try XCTUnwrap(
        session.nativeAutoProfile.readyFor(decodeGeneration: 2, quality: quality))
      XCTAssertNil(ready.artifacts)
      XCTAssertNil(session.nativeAutoProfile.readyFor(decodeGeneration: 1, quality: quality))
      XCTAssertNil(session.nativeAutoProfile.readyFor(decodeGeneration: 2, quality: .preview))
      XCTAssertFalse(firstPublished, "The retired source waiter cannot publish")
      XCTAssertFalse(previewPublished, "The retired quality waiter cannot publish")
      let downloads = await gate.waitCount
      XCTAssertEqual(downloads, 1, "All profile revisions must share the owned source download")
      XCTAssertEqual(try Data(contentsOf: fixture), original)
      await session.nativeAutoProfile.cancelAndWait()
      await driver.closeSession()
    } catch {
      await gate.open()
      await session.nativeAutoProfile.cancelAndWait()
      await driver.closeSession()
      throw error
    }
  }

  func testSupersededColdSourceCannotStartProfileWork() async throws {
    let original = try Data(
      contentsOf: fixtureURL("test-fixtures/removal/basic/source.dng"))
    let gate = NativeAutoSourceGate()
    let started = expectation(description: "Cold source provider entered")
    let asset = AssetRef(displayName: "source", hintExtension: "dng", explicitIsRaw: true) {
      started.fulfill()
      await gate.wait()
      return original
    }
    let session = EditSession(asset: asset)
    let driver = GpuLiveDriver()
    do {
      try await driver.open(
        width: 16, height: 16, identity: .init(decodeGeneration: 1, crop: .identity)
      ) { Array(repeating: Float(0.18), count: 16 * 16 * 4) }
      let gen = await session.renderActor.currentGeneration()
      let attempt = Task {
        await session.prepareGpuAutoProfile(
          driver: driver, model: .default, decodeGeneration: 1, quality: .preview, gen: gen)
      }
      await fulfillment(of: [started], timeout: 3)
      let admitted = expectation(description: "Newer actor generation admitted")
      let next = await session.renderActor.scheduleRender(phase: .fast) { _ in admitted.fulfill() }
      XCTAssertGreaterThan(next, gen)
      await fulfillment(of: [admitted], timeout: 3)
      await gate.open()
      let current = await attempt.value
      XCTAssertFalse(current)
      XCTAssertTrue(driver.needsAutoProfileFit, "A stale source cannot mutate the provisional fit")
      XCTAssertFalse(session.nativeAutoProfile.hasRequested)
      await session.nativeAutoProfile.cancelAndWait()
      await driver.closeSession()
    } catch {
      await gate.open()
      await session.nativeAutoProfile.cancelAndWait()
      await driver.closeSession()
      throw error
    }
  }

  func testNoPreviewIsAJoinedNegativeResultAndQualityKeysStayDistinct() async throws {
    let source = fixtureURL("test-fixtures/removal/basic/source.dng")
    let original = try Data(contentsOf: source)
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "native-auto-absent")
    defer { try? FileManager.default.removeItem(at: directory) }
    let raw = directory.appendingPathComponent("source.dng")
    try original.write(to: raw)
    let preparation = NativeAutoProfilePreparation()
    let results = try await withThrowingTaskGroup(of: NativeAutoProfile.self) { group in
      for _ in 0..<8 {
        group.addTask {
          try await preparation.prepare(url: raw, scope: directory, quality: .full)
        }
      }
      var results: [NativeAutoProfile] = []
      for try await result in group { results.append(result) }
      return results
    }
    XCTAssertEqual(results.count, 8)
    XCTAssertEqual(Set(results.map(\.id)).count, 1)
    XCTAssertTrue(results.allSatisfy { $0.artifacts == nil })
    let preview = try await preparation.prepare(url: raw, scope: directory, quality: .preview)
    XCTAssertNotEqual(preview.id, results[0].id)
    let repeated = try await preparation.prepare(url: raw, scope: directory, quality: .preview)
    XCTAssertEqual(preview.id, repeated.id)
    await preparation.clearReady()
    let reset = try await preparation.prepare(url: raw, scope: directory, quality: .preview)
    XCTAssertNotEqual(preview.id, reset.id)
    XCTAssertEqual(try Data(contentsOf: raw), original)
  }

  func testSettledAbsentResultWaitsForFrameAndAllowsCPUAfterGPUFailure() async throws {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "native-auto-fallback")
    defer { try? FileManager.default.removeItem(at: directory) }
    let raw = directory.appendingPathComponent("source.dng")
    try FileManager.default.copyItem(
      at: fixtureURL("test-fixtures/removal/basic/source.dng"),
      to: raw)
    let session = EditSession(asset: AssetRef(url: raw))
    let quality: PipelineRenderer.Quality = AmazeFlag.isEnabled ? .amaze : .full
    let source = await session.renderActor.rawRenderSource
    XCTAssertNil(
      session.nativeAutoProfile.prepared(
        asset: session.asset, source: source,
        quality: quality, decodeGeneration: 1, onReady: {}))
    XCTAssertFalse(session.hasSettledAutoProfile)
    await session.nativeAutoProfile.awaitPreparation()
    let ready = try XCTUnwrap(session.nativeAutoProfile.ready)
    XCTAssertNil(ready.artifacts)
    XCTAssertFalse(session.hasSettledAutoProfile, "A ready tail is not yet a displayed frame")
    session.nativeAutoFrameID = ready.id
    XCTAssertTrue(session.hasSettledAutoProfile)
    // A previous Metal frame cannot authorize persistence of a provisional
    // CPU fallback. After failure the current CPU frame owns that decision.
    session.gpuFramePresented = true
    XCTAssertFalse(session.hasSettledAutoProfile)
    session.gpuPresentFailed = true
    XCTAssertTrue(session.hasSettledAutoProfile)
    session.nativeAutoFrameID = nil
    XCTAssertFalse(session.hasSettledAutoProfile)
    await session.nativeAutoProfile.cancelAndWait()
  }

  func testInvalidNativeTailCannotBecomeALegacyFallbackFrame() {
    let native = NativeAutoProfile(
      artifacts: AutoProfileArtifacts(curveFlat: nil, lutSize: 2, lutData: [0.2]))
    let pipeline = ImageEditPipeline()
    let decoded = CIImage(color: .init(red: 0.2, green: 0.3, blue: 0.4, alpha: 1))
      .cropped(to: CGRect(x: 0, y: 0, width: 4, height: 3))
    XCTAssertThrowsError(
      try pipeline.processSceneLinearWithAuto(
        decoded: decoded, model: AdjustmentModel(), nativeAutoProfile: native))
  }

  func testMetadataAndQualityChangesInvalidateIdentity() throws {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "native-auto-identity")
    defer { try? FileManager.default.removeItem(at: directory) }
    let raw = directory.appendingPathComponent("source.dng")
    try Data([1, 2, 3]).write(to: raw)
    let full = try NativeAutoProfilePreparation.Key.read(url: raw, quality: .full)
    let preview = try NativeAutoProfilePreparation.Key.read(url: raw, quality: .preview)
    XCTAssertNotEqual(full, preview)
    let alias = directory.appendingPathComponent("alias.dng")
    try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: raw)
    XCTAssertEqual(full, try NativeAutoProfilePreparation.Key.read(url: alias, quality: .full))
    try Data([1, 2, 3, 4]).write(to: raw)
    XCTAssertNotEqual(full, try NativeAutoProfilePreparation.Key.read(url: raw, quality: .full))
  }

  func testCancelledRemoteStagingCannotPublishToTheEditor() async throws {
    let original = try Data(
      contentsOf:
        fixtureURL("test-fixtures/removal/basic/source.dng"))
    let gate = NativeAutoSourceGate()
    let started = expectation(description: "Source provider entered")
    let asset = AssetRef(displayName: "source", hintExtension: "dng", explicitIsRaw: true) {
      started.fulfill()
      await gate.wait()
      return original
    }
    let source = RawRenderSource(asset: asset)
    let state = NativeAutoProfileState()
    var published = 0
    XCTAssertNil(
      state.prepared(
        asset: asset, source: source, quality: .full, decodeGeneration: 1
      ) { published += 1 })
    await fulfillment(of: [started], timeout: 3)
    let opener = Task {
      try? await Task.sleep(for: .milliseconds(10))
      await gate.open()
    }
    await state.cancelAndWait()
    await opener.value
    XCTAssertNil(state.ready)
    XCTAssertEqual(published, 0)
  }
}

private actor NativeAutoSourceGate {
  private var opened = false
  private var continuations: [CheckedContinuation<Void, Never>] = []
  private(set) var waitCount = 0
  func wait() async {
    waitCount += 1
    if opened { return }
    await withCheckedContinuation { continuations.append($0) }
  }
  func open() {
    opened = true
    for continuation in continuations { continuation.resume() }
    continuations.removeAll()
  }
}
