import CoreImage
import XCTest

@testable import MapleCore

extension EditSessionDecodedCacheTests {
  /// Render tests autosave edits. Their RAW must be an owned copy, because
  /// fixture directories can be shared by multiple worktrees or test runs.
  private func makeIsolatedFixtureSession(from source: URL) throws -> EditSession {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try FileManager.default.removeItem(at: directory) }
    let copy = directory.appendingPathComponent(source.lastPathComponent)
    try FileManager.default.copyItem(at: source, to: copy)
    let session = EditSession(asset: AssetRef(url: copy))
    addTeardownBlock {
      await session.renderActor.cancelAll()
      await session.flushPendingSidecarWrite()
      await session.releaseTransientMemory()
    }
    return session
  }

  func testFixtureSessionAutosavesOnlyBesideItsTemporaryCopy() async throws {
    let fixture = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try FileManager.default.removeItem(at: directory) }
    let original = directory.appendingPathComponent("original.dng")
    try FileManager.default.copyItem(at: fixture, to: original)
    let sidecar = original.deletingPathExtension().appendingPathExtension("xmp")
    let xml = XMPSerializer.serialize(model: .default, culling: CullingState())
    try xml.write(to: sidecar, atomically: true, encoding: .utf8)
    let originalBytes = try Data(contentsOf: original)
    let sidecarBytes = try Data(contentsOf: sidecar)
    let originalDate = try original.resourceValues(forKeys: [.contentModificationDateKey])
      .contentModificationDate
    let sidecarDate = try sidecar.resourceValues(forKeys: [.contentModificationDateKey])
      .contentModificationDate

    let session = try makeIsolatedFixtureSession(from: original)
    XCTAssertNotEqual(session.asset.sidecarURL, sidecar)
    session.model.exposure = 0.5
    await session.flushPendingSidecarWrite()

    let written = try String(contentsOf: XCTUnwrap(session.asset.sidecarURL), encoding: .utf8)
    let (saved, _) = try XMPParser.parse(written)
    XCTAssertEqual(saved.exposure, 0.5, "Exercise the actual sidecar autosave boundary")
    XCTAssertEqual(try Data(contentsOf: original), originalBytes)
    XCTAssertEqual(try Data(contentsOf: sidecar), sidecarBytes)
    XCTAssertEqual(
      try original.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
      originalDate)
    XCTAssertEqual(
      try sidecar.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
      sidecarDate)
    XCTAssertEqual(
      Set(try FileManager.default.contentsOfDirectory(atPath: directory.path)),
      ["original.dng", "original.xmp"])
  }

  /// Cold-open second-render parity: when fixture is present, run a
  /// real decode through `ensureRenderStarted`, wait for the Rust
  /// pass to land in the actor's cache AND the first preview to
  /// publish (proving the cold pipeline drained), then verify a
  /// second `_scheduleRender` call reuses the cache rather than
  /// re-FFIing. We can't easily count Rust calls without invasive
  /// instrumentation; instead we assert the second slider tick's
  /// publish latency is well under the cold-decode budget. On a
  /// 100 MP RAW the FFI is multi-second; a cached re-render lands in
  /// tens of milliseconds.
  func testColdOpenSecondRenderUsesCachedDecode() async throws {
    let fixturePath = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("test-fixtures/raws/test_0002.dng")

    guard FileManager.default.fileExists(atPath: fixturePath.path) else {
      throw XCTSkip("test_0002.dng fixture not present; skipping")
    }

    let session = try makeIsolatedFixtureSession(from: fixturePath)
    let asset = session.asset
    await MainActor.run {
      session.previewSize = CGSize(width: 1500, height: 1000)
      session.pixelScale = 0  // fit
    }
    session.ensureRenderStarted()

    // Wait up to 30 s for the cold Rust decode to populate the
    // cache AND for the first render to publish.
    let coldDeadline = Date().addingTimeInterval(30.0)
    while Date() < coldDeadline {
      let cached = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
      let isRendering = await session.isRendering
      if cached && !isRendering {
        try await Task.sleep(for: .milliseconds(300))
        break
      }
      try await Task.sleep(for: .milliseconds(100))
    }
    let populated = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
    guard populated else {
      return XCTFail("Rust decode did not populate cache within 30 s")
    }

    // Now mutate the model — this triggers `_scheduleRender(.fast)`
    // through the `model.didSet`. Time how long it takes for the
    // fast render to publish.
    let beforePreview = await session.renderedPreview
    let t0 = ContinuousClock.now
    await MainActor.run {
      session.model.exposure = 0.5
    }
    let warmDeadline = Date().addingTimeInterval(2.5)
    var publishedAfter = false
    while Date() < warmDeadline {
      let p = await session.renderedPreview
      if p !== beforePreview {
        publishedAfter = true
        break
      }
      try await Task.sleep(for: .milliseconds(20))
    }
    let elapsed = ContinuousClock.now - t0
    let elapsedMs =
      Double(elapsed.components.seconds) * 1000
      + Double(elapsed.components.attoseconds) / 1e15
    XCTAssertTrue(publishedAfter, "no preview update within 2.5 s of slider tick")
    XCTAssertLessThan(
      elapsedMs, 1500,
      "cached slider tick should land in <1.5 s; got \(elapsedMs) ms — cache miss?")
    print("CACHED_SLIDER_TICK_MS \(elapsedMs)")
    let stillCached = await session.renderActor._testDecodedCachePopulated(forAsset: asset)
    let stillFresh = await session.renderActor._testDecodedCacheIsFresh(forAsset: asset)
    XCTAssertTrue(stillCached, "decoded cache should still be populated after a slider tick")
    XCTAssertTrue(stillFresh, "decoded cache should still be fresh after a slider tick")
  }

  /// #871: the decode buffer is profile-dependent (Auto develops
  /// auto_exposure Off; Neutral keeps it On), so the `profile` param must
  /// route through `sharedDecode` to a DISTINCT decode and the cache must
  /// re-key on it — a Neutral→Auto toggle must NOT serve the Neutral
  /// (AE-On) buffer to the Auto render. Exercises the actor concurrency
  /// surface the `decodeSceneLinear`-direct tests bypass: `decodeProfile`
  /// in the in-flight task identity, `decodedProfile`, and `snapshot.profile`.
  /// Fixture-gated on a real RAW (the FFI must actually develop AE).
  func testSharedDecodeReKeysOnProfile871() async throws {
    let fixturePath = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("test-fixtures/raws/test_0003.CR2")
    guard FileManager.default.fileExists(atPath: fixturePath.path) else {
      throw XCTSkip("test_0003.CR2 fixture not present; skipping")
    }
    let asset = AssetRef(url: fixturePath)
    let pipeline = ImageEditPipeline()
    let actor = RenderActor(pipeline: pipeline)
    let identity: @Sendable (CIImage, AssetRef) async -> CIImage = { img, _ in img }

    // Full-res decode (target nil) so a single cache slot is written.
    guard
      let neutral = await actor.sharedDecode(
        asset: asset, target: nil, profile: .neutral, normalize: identity
      )
    else { throw XCTSkip("neutral decode nil") }
    let snapNeutral = await actor.snapshot(forAsset: asset)
    XCTAssertEqual(
      snapNeutral.profile, .neutral,
      "cache must record the Neutral decode profile")

    guard
      let auto = await actor.sharedDecode(
        asset: asset, target: nil, profile: .auto, normalize: identity
      )
    else { throw XCTSkip("auto decode nil") }
    let snapAuto = await actor.snapshot(forAsset: asset)
    XCTAssertEqual(
      snapAuto.profile, .auto,
      "an Auto decode after a Neutral one must RE-KEY the cache to Auto "
        + "(not serve the cached Neutral buffer) — #871")

    // The Auto buffer (AE-Off) must be meaningfully darker than the
    // Neutral buffer (AE-On). If the profile param were ignored / the
    // cache served the same buffer, the two means would be equal.
    func meanGreen(_ ci: CIImage) -> Double {
      let ctx = CIContext(options: [
        .workingColorSpace: CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!,
        .workingFormat: CIFormat.RGBAf,
      ])
      let e = ci.extent
      let w = 48
      let h = 48
      var px = [Float](repeating: 0, count: w * h * 4)
      px.withUnsafeMutableBytes { buf in
        ctx.render(
          ci.transformed(
            by: CGAffineTransform(
              scaleX: CGFloat(w) / e.width, y: CGFloat(h) / e.height)),
          toBitmap: buf.baseAddress!, rowBytes: w * 16,
          bounds: CGRect(x: 0, y: 0, width: w, height: h),
          format: .RGBAf,
          colorSpace: CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
        )
      }
      var s = 0.0
      for i in 0..<(w * h) { s += Double(px[i * 4 + 1]) }
      return s / Double(w * h)
    }
    let aMean = meanGreen(auto)
    let nMean = meanGreen(neutral)
    XCTAssertLessThan(
      aMean, nMean * 0.95,
      "Auto buffer (AE-Off) must be darker than Neutral (AE-On) — equal means the "
        + "profile param didn't route to a distinct decode / cache served the wrong buffer "
        + "(auto=\(aMean) neutral=\(nMean))."
    )
  }

}
