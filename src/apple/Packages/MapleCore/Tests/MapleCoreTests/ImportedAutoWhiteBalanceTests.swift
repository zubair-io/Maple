import Foundation
import XCTest

@testable import MapleCore

/// #4669: a name-only `crs:WhiteBalance="Auto"` renders As Shot first, resolves
/// once off the first frame, and its sidecar stays name-only.
@MainActor
final class ImportedAutoWhiteBalanceTests: XCTestCase {
  private let nameOnly = """
    <x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:keep="urn:maple-test:keep" keep:Unknown="byte-for-byte" crs:WhiteBalance="Auto"/></rdf:RDF></x:xmpmeta>
    """

  private func stagedRaw(_ prefix: String) throws -> (directory: URL, raw: URL) {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: prefix)
    let raw = directory.appendingPathComponent("source.dng")
    try FileManager.default.copyItem(
      at: try PartialWhiteBalanceFixture.root().appendingPathComponent("source.dng"), to: raw)
    return (directory, raw)
  }

  private func activeXmp(_ sidecar: URL) throws -> String {
    try WorkflowSidecarCore.checkpoint(xmp: String(contentsOf: sidecar, encoding: .utf8))
  }

  func testNameOnlyAutoSurvivesRealSidecarRoundTripAndUnrelatedEdits() throws {
    let directory = try SidecarContractIO.makeTempDirectory(prefix: "imported-auto-wb")
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("source.xmp")
    try nameOnly.write(to: path, atomically: true, encoding: .utf8)
    let imported = try XMPParser.parse(data: Data(contentsOf: path)).0
    XCTAssertEqual(imported.whiteBalancePreset, .auto)
    let intent = try XCTUnwrap(imported.partialWhiteBalance)
    XCTAssertTrue(intent.isUnresolvedAuto)
    var edited = imported
    edited.exposure = 1.25
    try XMPSerializer.serialize(model: edited, culling: CullingState())
      .write(to: path, atomically: true, encoding: .utf8)
    let saved = try String(contentsOf: path, encoding: .utf8)
    XCTAssertTrue(saved.contains(#"crs:WhiteBalance="Auto""#))
    XCTAssertFalse(saved.contains("crs:Temperature="))
    XCTAssertFalse(saved.contains("crs:Tint="))
    XCTAssertEqual(try XMPParser.parse(saved).0.partialWhiteBalance, intent)
    let explicit = try XMPParser.parse(
      nameOnly.replacingOccurrences(
        of: #"crs:WhiteBalance="Auto""#,
        with: #"crs:WhiteBalance="Auto" crs:Temperature="6500" crs:Tint="0""#)
    ).0
    XCTAssertNil(explicit.partialWhiteBalance)
    XCTAssertEqual(explicit.temperature, 6500)
    XCTAssertEqual(explicit.tint, 0)
  }

  func testResolvedNameOnlyAutoKeepsItsCorrectionWhenCopiedRelatively() throws {
    let imported = try XMPParser.parse(nameOnly).0
    XCTAssertEqual(imported.wbSource, .asShot)
    let resolved = imported.resolvingImportedWhiteBalance(
      ResolvedWhiteBalance(temperature: 7200, tint: 25))
    XCTAssertEqual(resolved.wbSource, .auto)
    XCTAssertEqual(resolved.wbAlgorithmVersion, autoWhiteBalanceAlgorithmVersion)
    let patch = try AdjustmentTransfer.prepare(
      source: resolved, groups: [.whiteBalance], relativeWhiteBalance: true,
      sourceBaseline: WhiteBalanceTransferBaseline(temperature: 6000, tint: 5),
      targetBaseline: WhiteBalanceTransferBaseline(temperature: 5000, tint: -10))
    XCTAssertEqual(patch.model.temperature, 6200)
    XCTAssertEqual(patch.model.tint, 10)

    let directory = try SidecarContractIO.makeTempDirectory(prefix: "imported-auto-provenance")
    defer { try? FileManager.default.removeItem(at: directory) }
    let sidecar = directory.appendingPathComponent("source.xmp")
    try XMPSerializer.serialize(model: resolved, culling: CullingState())
      .write(to: sidecar, atomically: true, encoding: .utf8)
    let saved = try String(contentsOf: sidecar, encoding: .utf8)
    XCTAssertTrue(saved.contains(#"crs:WhiteBalance="Auto""#))
    XCTAssertFalse(saved.contains("crs:Temperature="))
    XCTAssertFalse(saved.contains("crs:Tint="))
    XCTAssertEqual(try XMPParser.parse(saved).0.wbSource, .auto)
  }

  func testResolvingASingleImportedAxisDoesNotReplaceItsProvenance() throws {
    var partial = try XMPParser.parse(
      nameOnly.replacingOccurrences(
        of: #"crs:WhiteBalance="Auto""#, with: #"crs:Temperature="6200""#)
    ).0
    partial.wbSource = .manual
    let resolved = partial.resolvingImportedWhiteBalance(
      ResolvedWhiteBalance(temperature: 6200, tint: 15))
    XCTAssertEqual(resolved.wbSource, .manual)
    XCTAssertEqual(resolved.wbAlgorithmVersion, 0)
  }

  /// #5922: the resolver hands its cancel flag to the core estimate, so a set
  /// flag stops the estimate inside the FFI call and resolves nothing.
  func testASetCancelFlagStopsTheEstimateInsideTheFFICall() throws {
    let (directory, raw) = try stagedRaw("imported-auto-wb-cancel")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cancelled = CancelFlag()
    cancelled.requestCancel()
    XCTAssertThrowsError(
      try raw.path.withCString {
        try ImportedWhiteBalanceResolver.resolve(path: $0, xml: nameOnly, cancel: cancelled)
      }
    ) { XCTAssertTrue($0 is CancellationError, "\($0)") }
    let pair = try raw.path.withCString {
      try ImportedWhiteBalanceResolver.resolve(path: $0, xml: nameOnly, cancel: CancelFlag())
    }
    XCTAssertTrue(pair.temperature.isFinite && pair.tint.isFinite)
  }

  func testFinalOutputResolutionUsesTheSessionFileAndLeavesOriginalsUntouched() async throws {
    let (directory, raw) = try stagedRaw("imported-auto-wb-final")
    defer { try? FileManager.default.removeItem(at: directory) }
    let bytes = try Data(contentsOf: raw)
    let imported = try XMPParser.parse(nameOnly).0
    let resolved = try await ImportedWhiteBalanceResolver.resolve(
      asset: AssetRef(url: raw), model: imported)
    let target = try XCTUnwrap(resolved.partialWhiteBalance?.resolvedTarget)
    let shared = try await ImportedWhiteBalanceResolver.resolve(
      asset: AssetRef(url: raw), model: imported, sessionRaw: { raw })
    XCTAssertEqual(shared, resolved)
    let settled = try await ImportedWhiteBalanceResolver.resolve(
      asset: AssetRef(url: raw), model: resolved)
    XCTAssertEqual(settled, resolved)
    XCTAssertEqual(resolved.temperature, target.temperature)
    XCTAssertEqual(resolved.tint, target.tint)
    XCTAssertEqual(resolved.exposure, imported.exposure)
    let cpu = PipelineRenderer.makeParams(from: resolved, wbFrame: nil)
    let gpu = PipelineRenderer.makeGpuLiveParams(from: resolved, wbFrame: nil)
    XCTAssertEqual(cpu.temperature, gpu.temperature)
    XCTAssertEqual(cpu.tint, gpu.tint)
    XCTAssertEqual(Double(cpu.temperature), target.temperature, accuracy: 0.01)
    XCTAssertEqual(try Data(contentsOf: raw), bytes)
  }

  func testSessionRendersAsShotFirstThenResolvesOnceWithoutRewritingTheSidecar() async throws {
    let (directory, raw) = try stagedRaw("imported-auto-wb-session")
    defer { try? FileManager.default.removeItem(at: directory) }
    let bytes = try Data(contentsOf: raw)
    let sidecar = SidecarPath.sidecarURL(for: raw)
    try nameOnly.write(to: sidecar, atomically: true, encoding: .utf8)
    let session = EditSession(asset: AssetRef(url: raw))
    await session.loadSidecar()
    XCTAssertTrue(session.hasLoadedSidecar)
    XCTAssertNil(session.renderError)
    // Hydration estimated nothing: the first frame renders As Shot.
    XCTAssertEqual(session.model.partialWhiteBalance?.isUnresolvedAuto, true)
    XCTAssertNil(session.importedAuto.request)
    XCTAssertEqual(session.renderModel, session.model)
    let asShot = session.renderModel.liveWhiteBalance(in: nil)

    session.resolveImportedAutoWhiteBalance()
    let request = try XCTUnwrap(session.importedAuto.request)
    await request.value
    let expected = try await ImportedWhiteBalanceResolver.resolve(
      asset: AssetRef(url: raw), model: XMPParser.parse(nameOnly).0)
    let target = try XCTUnwrap(expected.partialWhiteBalance?.resolvedTarget)
    XCTAssertEqual(session.importedAuto.target, target)
    let live = session.renderModel.liveWhiteBalance(in: nil)
    XCTAssertEqual(live.temperature, target.temperature)
    XCTAssertEqual(live.tint, target.tint)
    XCTAssertFalse(live == asShot, "the re-render must change the white balance")
    // One request per session: a later trigger reuses the pair.
    session.resolveImportedAutoWhiteBalance()
    XCTAssertEqual(session.importedAuto.request, request)

    session.beginEdit(description: "Exposure")
    session.model.exposure = 1.25
    session.endEdit()
    await session.flushPendingSidecarWrite()
    let saved = try activeXmp(sidecar)
    XCTAssertTrue(saved.contains(#"crs:WhiteBalance="Auto""#))
    XCTAssertFalse(saved.contains("crs:Temperature="))
    XCTAssertFalse(saved.contains("crs:Tint="))
    XCTAssertTrue(saved.contains(#"keep:Unknown="byte-for-byte""#))
    session.undo()
    XCTAssertEqual(session.renderModel.liveWhiteBalance(in: nil).temperature, target.temperature)

    // A numeric WB action supersedes the intent and is never re-estimated.
    session.beginEdit(description: "White balance")
    ToolValueMapping.apply(5300, to: &session.model, tool: .temp)
    session.endEdit()
    XCTAssertNil(session.model.partialWhiteBalance)
    XCTAssertEqual(session.renderModel, session.model)
    await session.flushPendingSidecarWrite()
    XCTAssertTrue(try activeXmp(sidecar).contains("crs:Temperature="))
    XCTAssertEqual(try Data(contentsOf: raw), bytes)
    await session.releaseTransientMemory()
  }
}
