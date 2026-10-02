import CryptoKit
import Foundation
import QuartzCore
import XCTest

@testable import MapleCore

extension EditorWorkflowPerfTests {
  /// Actual RAW/XMP/companions and the production editor GPU path. Controlled
  /// 512px constant patches qualify render cost, never reconstruction quality.
  @MainActor
  func test100MPAcceptedRemovalStacksAt60Hz() async throws {
    guard ProcessInfo.processInfo.environment["MAPLE_PERF"] == "1" else {
      throw XCTSkip("Set MAPLE_PERF=1 for the real 100MP removal editor benchmark")
    }
    let root = SliderTickPerfHarness.repoRoot().appendingPathComponent("test-fixtures/raws")
    let original = root.appendingPathComponent("dji-mavic3pro-100mp.dng")
    let fixtures = root.appendingPathComponent("removal-perf")
    guard FileManager.default.fileExists(atPath: original.path),
      FileManager.default.fileExists(atPath: fixtures.appendingPathComponent("stack-10.xmp").path)
    else {
      throw XCTSkip("Install the canonical RAW and generate the removal-perf fixtures")
    }
    let size = try XCTUnwrap(RawDimensions.read(from: original))
    report(["case": "removal-fixture", "width": size.width, "height": size.height])
    XCTAssertGreaterThanOrEqual(size.width * size.height, 100_000_000)
    guard size.width * size.height >= 100_000_000 else { return }
    let originalDigest = try autoreleasepool {
      let data = try Data(contentsOf: original)
      // Match the established canonical identity, not only a 100MP filename.
      let manifest = SliderTickPerfHarness.repoRoot().appendingPathComponent(
        "test-fixtures/qualification/browser-100mp-3669.json")
      let expected = try XCTUnwrap(
        JSONSerialization.jsonObject(with: Data(contentsOf: manifest)) as? [String: Any])
      let sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
      guard expected["sha256"] as? String == sha, expected["bytes"] as? Int == data.count else {
        throw RemovalError.invalid("The named RAW does not match the canonical 100MP identity")
      }
      return try RemovalBridge.digest(data)
    }
    report(["case": "removal-source", "digest": originalDigest])
    var previousFrame: (initial: String, native: String)?
    for count in [0, 1, 10] {
      let frame = try await measureRemovalStack(
        original: original, fixtures: fixtures, count: count, originalDigest: originalDigest)
      if let previousFrame {
        XCTAssertNotEqual(
          frame.initial, previousFrame.initial, "Accepted patches must change initial GPU pixels")
        XCTAssertNotEqual(
          frame.native, previousFrame.native, "Accepted patches must change native Auto GPU pixels")
      }
      previousFrame = frame
    }
    XCTAssertEqual(
      try autoreleasepool { try RemovalBridge.digest(Data(contentsOf: original)) }, originalDigest)
  }

  @MainActor
  private func measureRemovalStack(
    original: URL, fixtures: URL, count: Int, originalDigest: String
  ) async throws -> (initial: String, native: String) {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let staged = directory.appendingPathComponent(original.lastPathComponent)
    try FileManager.default.copyItem(at: original.resolvingSymlinksInPath(), to: staged)
    try FileManager.default.copyItem(
      at: fixtures.appendingPathComponent("stack-\(count).xmp"),
      to: SidecarPath.sidecarURL(for: staged))
    if count > 0 {
      try FileManager.default.copyItem(
        at: fixtures.appendingPathComponent(".maple"),
        to: directory.appendingPathComponent(".maple"))
    }
    await RenderedPreviewCache.shared.configure(folderURL: directory)
    report(["case": "removal-staged", "patchCount": count])
    let session = EditSession(asset: AssetRef(url: staged))
    let layer = CAMetalLayer()
    layer.bounds = CGRect(x: 0, y: 0, width: 1920, height: 1280)
    #if os(macOS)
      let window = makeWindow(layer: layer)
    #endif
    report(["case": "removal-surface", "patchCount": count])
    // Await cleanup on every throwing path before removing this actual library.
    do {
      let driver = try XCTUnwrap(session.gpuLiveDriver, "Removal benchmark requires live GPU")
      driver.register(layer: layer)
      session.previewSize = CGSize(width: 1920, height: 1280)
      session.pixelScale = 0
      let opened = ContinuousClock.now
      var firstSeedMs: Double?
      var firstGPUMs: Double?
      await session.loadSidecar()
      if let error = session.sidecarError { throw error }
      report(["case": "removal-hydrated", "patchCount": count])
      let records = session.model.inpaintRemovals?.json ?? "[]"
      let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(records.utf8)) as? [Any])
      XCTAssertEqual(rows.count, count)
      guard rows.count == count else {
        throw RemovalError.invalid("Expected \(count) accepted records, loaded \(rows.count)")
      }
      XCTAssertEqual(session.model.profile, .auto)
      session.ensureRenderStarted()
      try await waitUntil(timeout: .seconds(180)) {
        if let error = session.renderError { throw error }
        if session.renderedPreview != nil, firstSeedMs == nil {
          firstSeedMs = Self.ms(opened.duration(to: .now))
        }
        if session.gpuFramePresented, firstGPUMs == nil {
          firstGPUMs = Self.ms(opened.duration(to: .now))
        }
        return session.gpuFramePresented && !session.isResolvingFirstFrame
          && !session.isFullQualityDecoding
      }
      let openMs = Self.ms(opened.duration(to: .now))
      let decoded = await session.renderActor.snapshot(forAsset: session.asset)
      XCTAssertEqual(decoded.decodedAtModel?.inpaintRemovals?.json ?? "[]", records)
      let readback = await driver.renderCurrentFrameBytes(
        model: session.model, asShotCCT: session.asShotCCT,
        asShotTint: session.asShotTint, wbFrame: decoded.wbFrame)
      let frame = try XCTUnwrap(readback)
      let digest = try RemovalBridge.digest(Data(frame.bytes))
      // Readback/hash is outside the timed input loop. No synthetic decode seed.
      let exposure = try await measureDrag(
        name: "removal-\(count)-exposure", session: session,
        change: { $0.exposure = -1 + $1 * 2 })
      let contrast = try await measureDrag(
        name: "removal-\(count)-contrast", session: session,
        change: { $0.contrast = -20 + $1 * 40 })
      // Keep the immediate-interaction measurements above. Then require the
      // completed native tail and an actual publication using it; a provisional
      // proxy frame or an installed ID alone cannot qualify settled rendering.
      let nativeReadyAtImmediateEnd = session.hasSettledAutoProfile
      await session.nativeAutoProfile.awaitPreparation()
      let prepared = try XCTUnwrap(session.nativeAutoProfile.ready)
      XCTAssertNotNil(prepared.artifacts, "The canonical RAW must fit a native Auto tail")
      session._scheduleRender(phase: .fast)
      let settledSchedule = try XCTUnwrap(session.latestRenderSchedule)
      let settledGeneration = await settledSchedule.value
      try await waitUntil(timeout: .seconds(30)) {
        if let error = session.renderError { throw error }
        return session.lastPublishedRenderGeneration == settledGeneration
          && session.hasSettledAutoProfile
      }
      XCTAssertEqual(driver.nativeAutoProfileID, prepared.id)
      let nativeSettledMs = Self.ms(opened.duration(to: .now))
      let nativeReadback = await driver.renderCurrentFrameBytes(
        model: session.model, asShotCCT: session.asShotCCT,
        asShotTint: session.asShotTint, wbFrame: decoded.wbFrame)
      let nativeFrame = try XCTUnwrap(nativeReadback)
      let nativeDigest = try RemovalBridge.digest(Data(nativeFrame.bytes))
      let nativeExposure = try await measureDrag(
        name: "removal-\(count)-native-exposure", session: session,
        change: { $0.exposure = 1 - $1 * 2 })
      let nativeContrast = try await measureDrag(
        name: "removal-\(count)-native-contrast", session: session,
        change: { $0.contrast = 20 - $1 * 40 })
      XCTAssertEqual(driver.nativeAutoProfileID, prepared.id)
      XCTAssertTrue(session.hasSettledAutoProfile)
      XCTAssertEqual(session.model.inpaintRemovals?.json ?? "[]", records)
      var row = PerfRecordWriter.deviceSnapshot()
      row["case"] = "100MP-accepted-removals"
      row["patchCount"] = count
      row["patchWidth"] = 512
      row["patchHeight"] = 512
      row["fixture"] = original.lastPathComponent
      row["sourceDigest"] = originalDigest
      row["frameDigest"] = digest
      row["profile"] = String(describing: session.model.profile)
      row["viewportWidth"] = 1920
      row["viewportHeight"] = 1280
      row["coldOpenMs"] = openMs
      row["firstSeedMs"] = firstSeedMs
      row["firstGPUMs"] = firstGPUMs
      row["nativeReadyAtImmediateEnd"] = nativeReadyAtImmediateEnd
      row["nativeSettledMs"] = nativeSettledMs
      row["nativeFrameDigest"] = nativeDigest
      row["tickExposure"] = exposure.asJSON
      row["tickContrast"] = contrast.asJSON
      row["tickNativeExposure"] = nativeExposure.asJSON
      row["tickNativeContrast"] = nativeContrast.asJSON
      row["targetMs"] = 16
      row["hardLimitMs"] = 50
      row["excludes"] = "gesture dispatch, scanout, allocation trace, inference and AI quality"
      row["commitSha"] = PerfRecordWriter.gitCommitSha()
      report(row)
      XCTAssertLessThanOrEqual(exposure.maxMs, 50, "Removal exposure tick exceeds the hard limit")
      XCTAssertLessThanOrEqual(contrast.maxMs, 50, "Removal contrast tick exceeds the hard limit")
      XCTAssertLessThanOrEqual(
        nativeExposure.maxMs, 50, "Native removal exposure tick exceeds the hard limit")
      XCTAssertLessThanOrEqual(
        nativeContrast.maxMs, 50, "Native removal contrast tick exceeds the hard limit")
      await closeRemovalBenchmark(session)
      #if os(macOS)
        window.orderOut(nil)
      #endif
      withExtendedLifetime(layer) {}
      return (digest, nativeDigest)
    } catch {
      await closeRemovalBenchmark(session)
      #if os(macOS)
        window.orderOut(nil)
      #endif
      withExtendedLifetime(layer) {}
      throw error
    }
  }

  @MainActor
  private func closeRemovalBenchmark(_ session: EditSession) async {
    _ = await session.latestRenderSchedule?.value
    await session.renderActor.finishBenchmarkWork()
    await session.cancelAndJoinDisplayPreviewPersist()
    await session.flushPendingSidecarWrite()
    await session.gpuLiveDriver?.closeSession()
    await session.releaseTransientMemory()
  }
}
