import Foundation
import XCTest

@testable import MapleCore

@MainActor
final class RemovalSnapshotTests: XCTestCase {
  private func fixture(_ name: String, _ ext: String) throws -> Data {
    try Data(
      contentsOf: XCTUnwrap(
        Bundle.module.url(
          forResource: name, withExtension: ext, subdirectory: "removal/calibration")))
  }

  private func stage() throws -> EditSession {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let raw = directory.appendingPathComponent("photo.dng")
    try fixture("source", "dng").write(to: raw)
    try fixture("prior", "xmp").write(to: SidecarPath.sidecarURL(for: raw))
    return EditSession(asset: AssetRef(url: raw))
  }

  private func proposal() throws -> NativeRemovalProposal {
    NativeRemovalProposal(
      request: String(decoding: try fixture("request", "txt"), as: UTF8.self),
      mask: try fixture("mask", "mimf"), patch: try fixture("patch", "f16"))
  }

  func testExternalScalarCullingAndForeignXMLRejectKeepWithoutOverwritingThem() async throws {
    for mutation in 0..<3 {
      let session = try stage()
      let before = session.model
      let snapshot = try await session.removalAuthoringSnapshot()
      let sidecar = try XCTUnwrap(session.asset.sidecarURL)
      let xml = try String(contentsOf: sidecar, encoding: .utf8)
      let changed: String
      switch mutation {
      case 0:
        var external = before
        external.exposure = 2
        changed = XMPSerializer.serialize(
          model: external, culling: session.culling,
          passthrough: XMPParser.parsePassthrough(xml))
      case 1:
        var external = session.culling
        external.stars = 5
        changed = XMPSerializer.serialize(
          model: before, culling: external,
          passthrough: XMPParser.parsePassthrough(xml))
      default:
        changed = xml.replacingOccurrences(of: "untouched", with: "external edit")
      }
      let external = Data(changed.utf8)
      XCTAssertNotEqual(external, Data(xml.utf8))
      try external.write(to: sidecar, options: .atomic)
      do {
        try await session.acceptRemoval(proposal(), snapshot: snapshot)
        XCTFail("Every part of the authoring XMP snapshot is a dependency")
      } catch RemovalError.saveConflict {}
      await session.flushPendingSidecarWrite()
      XCTAssertEqual(session.model, before)
      XCTAssertTrue(session.undoHistory.isEmpty)
      XCTAssertEqual(
        try Data(contentsOf: sidecar), external,
        "No deferred stale scalar write may follow the rejected Keep")
      do {
        _ = try await session.removalAuthoringSnapshot()
        XCTFail("A retry must not pair external XML with the stale in-memory model")
      } catch RemovalError.saveConflict {}
      await session.releaseTransientMemory()
      XCTAssertEqual(try Data(contentsOf: sidecar), external)
    }
  }

  func testSnapshotFlushesOurPendingScalarWriteAndIgnoresAnIdenticalRewrite() async throws {
    let session = try stage()
    session.beginEdit()
    session.model.exposure = 1.25
    session.endEdit()
    let snapshot = try await session.removalAuthoringSnapshot()
    let sidecar = try XCTUnwrap(session.asset.sidecarURL)
    let bytes = try Data(contentsOf: sidecar)
    XCTAssertEqual(try XMPParser.parse(data: bytes).0.exposure, 1.25)
    try bytes.write(to: sidecar, options: .atomic)
    try await session.acceptRemoval(proposal(), snapshot: snapshot)
    await session.flushPendingSidecarWrite()
    XCTAssertNotNil(session.model.inpaintRemovals)
    XCTAssertEqual(session.model.exposure, 1.25)
    XCTAssertEqual(try XMPParser.parse(data: Data(contentsOf: sidecar)).0, session.model)
    await session.releaseTransientMemory()
  }

  func testExternalCreationAfterMissingSnapshotIsAConflict() async throws {
    let session = try stage()
    await session.flushPendingSidecarWrite()
    let sidecar = try XCTUnwrap(session.asset.sidecarURL)
    try FileManager.default.removeItem(at: sidecar)
    let snapshot = try await session.removalAuthoringSnapshot()
    XCTAssertEqual(snapshot.sidecarRevision, .missing)
    let external = try fixture("prior", "xmp")
    try external.write(to: sidecar)
    do {
      try await session.acceptRemoval(proposal(), snapshot: snapshot)
      XCTFail("Creating a previously missing XMP invalidates the proposal")
    } catch RemovalError.saveConflict {}
    await session.flushPendingSidecarWrite()
    XCTAssertEqual(try Data(contentsOf: sidecar), external)
    XCTAssertTrue(session.undoHistory.isEmpty)
    await session.releaseTransientMemory()
  }
}
