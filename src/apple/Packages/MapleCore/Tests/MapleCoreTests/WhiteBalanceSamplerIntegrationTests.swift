import XCTest

@testable import MapleCore

/// Exercises the actual Rust sampler and path-only bridge with the committed
/// 64×64 grey RAW, including temporary staging for PhotoKit/cloud assets.
/// No fixture skip and no injected sampler or sidecar implementation.
final class WhiteBalanceSamplerIntegrationTests: XCTestCase {
  private var fixtureURL: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()  // MapleCoreTests
      .deletingLastPathComponent()  // Tests
      .deletingLastPathComponent()  // MapleCore
      .deletingLastPathComponent()  // Packages
      .deletingLastPathComponent()  // apple
      .appendingPathComponent("MapleUITests/Fixtures/synthetic/grey-l018-rggb.dng")
  }

  func testNativeSamplerMatchesLocalAndBytesSourcesWithoutWritingEitherOriginal() async throws {
    let bytes = try Data(contentsOf: fixtureURL)
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let raw = directory.appendingPathComponent("original.dng")
    let sidecar = directory.appendingPathComponent("original.xmp")
    try bytes.write(to: raw)
    let xml = XMPSerializer.serialize(model: .default, culling: CullingState())
    try xml.write(to: sidecar, atomically: true, encoding: .utf8)
    let originalDate =
      try FileManager.default.attributesOfItem(atPath: raw.path)[.modificationDate] as? Date
    let sidecarDate =
      try FileManager.default.attributesOfItem(atPath: sidecar.path)[.modificationDate] as? Date
    try FileManager.default.setAttributes([.posixPermissions: 0o444], ofItemAtPath: raw.path)
    try FileManager.default.setAttributes([.posixPermissions: 0o444], ofItemAtPath: sidecar.path)

    let point = CGPoint(x: 0.25, y: 0.75)
    let local = try await WhiteBalanceSampler.sample(
      asset: AssetRef(url: raw), model: .default, point: point)
    let remote = try await WhiteBalanceSampler.sample(
      asset: AssetRef(
        displayName: "Cloud RAW", hintExtension: "dng", explicitIsRaw: true,
        bytesProvider: { bytes }), model: .default, point: point)
    XCTAssertTrue(local.temperature.isFinite)
    XCTAssertTrue(local.tint.isFinite)
    XCTAssertTrue(AdjustmentModel.temperatureRange.contains(local.temperature))
    XCTAssertTrue(AdjustmentModel.tintRange.contains(local.tint))
    XCTAssertGreaterThan(local.algorithmVersion, 0)
    XCTAssertEqual(local.temperature, remote.temperature)
    XCTAssertEqual(local.tint, remote.tint)
    XCTAssertEqual(local.algorithmVersion, remote.algorithmVersion)
    XCTAssertEqual(try Data(contentsOf: raw), bytes)
    XCTAssertEqual(try Data(contentsOf: fixtureURL), bytes)
    XCTAssertEqual(try String(contentsOf: sidecar, encoding: .utf8), xml)
    XCTAssertEqual(
      try FileManager.default.attributesOfItem(atPath: raw.path)[.modificationDate] as? Date,
      originalDate)
    XCTAssertEqual(
      try FileManager.default.attributesOfItem(atPath: sidecar.path)[.modificationDate] as? Date,
      sidecarDate)
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted(),
      ["original.dng", "original.xmp"])
  }

  @MainActor
  func testNativeSampleReplacesLegacyWhiteBalanceWithCurrentScale() async throws {
    var model = AdjustmentModel.default
    model.wbScaleVersion = 1
    let bytes = try Data(contentsOf: fixtureURL)
    let asset = AssetRef(
      displayName: "Synthetic gray", hintExtension: "dng", explicitIsRaw: true,
      bytesProvider: { bytes })
    let session = EditSession(asset: asset, model: model, culling: CullingState())
    let picker = WhiteBalancePicker(session: session)
    picker.arm()
    await picker.pick(at: CGPoint(x: 0.5, y: 0.5))
    XCTAssertNil(picker.message)
    XCTAssertEqual(session.model.wbSource, .sampled)
    XCTAssertEqual(session.model.wbScaleVersion, AdjustmentModel.default.wbScaleVersion)
    XCTAssertEqual(session.undoHistory.count, 1)
    session.undo()
    XCTAssertEqual(session.model, model)
  }
}
