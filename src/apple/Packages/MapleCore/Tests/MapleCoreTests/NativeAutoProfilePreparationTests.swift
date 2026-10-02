import CoreImage
import Foundation
import XCTest

@testable import MapleCore

@MainActor
final class NativeAutoProfilePreparationTests: XCTestCase {
  func testNoPreviewIsAJoinedNegativeResultAndQualityKeysStayDistinct() async throws {
    let source = AutoProfileCanvasParityTests.fixtureDir("test-fixtures/removal/basic/source.dng")
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
      at: AutoProfileCanvasParityTests.fixtureDir("test-fixtures/removal/basic/source.dng"),
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
        AutoProfileCanvasParityTests.fixtureDir("test-fixtures/removal/basic/source.dng"))
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
  private var continuation: CheckedContinuation<Void, Never>?
  func wait() async {
    if opened { return }
    await withCheckedContinuation { continuation = $0 }
  }
  func open() {
    opened = true
    continuation?.resume()
    continuation = nil
  }
}
