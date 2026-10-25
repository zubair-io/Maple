import XCTest

@testable import MapleCore

/// `SMBSource.writeXMP` publishes through the SMB sidecar store on an owned
/// Samba share: an existing sidecar's metadata and foreign regions survive,
/// a fresh one is created, and a changed document is never overwritten blind.
final class SMBSourceWriteXMPTests: XCTestCase {
  func testWriteXMPPreservesMetadataAndPassthroughOfTheExistingSidecar() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(
      testCase: self, initialXML: NativeWorkflowControlFixture.input(exposure: 0, tag: "B"))
    let sidecar = fixture.share.appendingPathComponent("photo.xmp")
    let existing = try String(contentsOf: sidecar, encoding: .utf8)
    var model = AdjustmentModel.default
    model.exposure = 0.75
    try await fixture.source.writeXMP(
      Sidecar(model: model, culling: CullingState(stars: 2)), for: try await fixture.image())

    let written = try String(contentsOf: sidecar, encoding: .utf8)
    XCTAssertNotEqual(written, existing)
    let (readModel, readCulling) = try XMPParser.parse(written)
    XCTAssertEqual(readModel.exposure, 0.75, accuracy: 0.0001)
    XCTAssertEqual(readCulling.stars, 2)
    XCTAssertEqual(XMPParser.parseMetadata(written).caption, "Caption B")
    XCTAssertTrue(
      written.contains(
        "<foreign:Audit xmlns:foreign=\"urn:maple:test\" z=\"B\" a=\"retained\"> B &amp; unchanged </foreign:Audit>"
      ), written)
    // The server-owned `.maple-lock` is persistent by design (#4065); only
    // the publication's own staging file must be gone.
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(atPath: fixture.share.path)
        .filter { !$0.hasPrefix(".") && !$0.hasSuffix(".maple-lock") }.sorted(),
      ["photo.dng", "photo.xmp"])
    XCTAssertFalse(
      try FileManager.default.contentsOfDirectory(atPath: fixture.share.path)
        .contains { $0.hasPrefix(".maple-xmp-") })
  }

  func testWriteXMPCreatesAMissingSidecarAndRewritesItsOwnSave() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self, initialXML: nil)
    let ref = try await fixture.image()
    let sidecar = fixture.share.appendingPathComponent("photo.xmp")
    var model = AdjustmentModel.default
    model.exposure = 1.25
    try await fixture.source.writeXMP(Sidecar(model: model, culling: CullingState()), for: ref)
    XCTAssertEqual(
      try XMPParser.parse(data: try Data(contentsOf: sidecar)).0.exposure, 1.25, accuracy: 0.0001)

    model.exposure = -0.5
    try await fixture.source.writeXMP(Sidecar(model: model, culling: CullingState()), for: ref)
    XCTAssertEqual(
      try XMPParser.parse(data: try Data(contentsOf: sidecar)).0.exposure, -0.5, accuracy: 0.0001)
  }

  func testWriteXMPWithoutAConnectionFailsDeterministically() async throws {
    do {
      try await SMBSource().writeXMP(
        Sidecar(model: .default, culling: CullingState()),
        for: ImageRef(id: "deadbeef", displayName: "photo.dng"))
      XCTFail("write must fail without a connection")
    } catch SMBError.notConnected {
    }
  }
}
