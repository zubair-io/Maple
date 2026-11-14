import Foundation
import XCTest

@testable import MapleCore

/// A stale SMB writer merges onto the share's current sidecar instead of refusing it (#5828).
final class SMBSidecarReconcileTests: XCTestCase {
  private func secondClient(_ fixture: OwnedSMBWorkflowFixture) async throws -> (
    SMBSource, ImageRef
  ) {
    let source = SMBSource()
    try await source.connect(credentials: fixture.credentials)
    let refs = try await source.images()
    return (source, try XCTUnwrap(refs.first { $0.displayName == "photo.dng" }))
  }

  private func shared(_ fixture: OwnedSMBWorkflowFixture) throws -> String {
    try String(contentsOf: fixture.share.appendingPathComponent("photo.xmp"), encoding: .utf8)
  }

  private func history(_ xml: String) throws -> [WorkflowHistoryEntry] {
    try WorkflowSidecarCore.read(xmp: xml)?.history ?? []
  }

  func testTwoClientsOnOneShareKeepBothEdits() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let ref = try await fixture.image()
    let first = SMBSidecarStore(source: fixture.source, ref: ref)
    let loaded = try await first.load()
    let (observer, observedRef) = try await secondClient(fixture)
    let second = SMBSidecarStore(source: observer, ref: observedRef)
    var other = try await second.load().0
    other.contrast = 30
    try await second.writeConfirmed(model: other, culling: loaded.1)

    var stale = loaded.0
    stale.exposure = 1.5
    try await first.commitSemantic(
      model: stale, culling: loaded.1, action: "adjustment", label: "Stale exposure")

    let merged = try shared(fixture)
    let model = try XMPParser.parse(merged).0
    XCTAssertEqual(model.exposure, 1.5, accuracy: 1e-9)
    XCTAssertEqual(model.contrast, 30, accuracy: 1e-9)
    let entries = try history(merged)
    XCTAssertEqual(entries.map(\.action), ["external", "adjustment"])
    XCTAssertEqual(try XMPParser.parse(entries[0].adjustmentXmp).0.contrast, 30, accuracy: 1e-9)
    XCTAssertEqual(try XMPParser.parse(entries[0].adjustmentXmp).0.exposure, 0, accuracy: 1e-9)
    XCTAssertEqual(XMPParser.parseMetadata(merged).caption, "Caption A")
    XCTAssertTrue(merged.contains("<foreign:Audit"))

    stale.exposure = 1.75
    try await first.writeConfirmed(model: stale, culling: loaded.1)
    let later = try XMPParser.parse(shared(fixture)).0
    XCTAssertEqual(later.contrast, 30, accuracy: 1e-9, "an unconfirmed merge is never reverted")
    XCTAssertEqual(later.exposure, 1.75, accuracy: 1e-9)
    XCTAssertEqual(try history(shared(fixture)).map(\.action), ["external", "adjustment"])
    XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
    await observer.disconnect()
    await fixture.close()
  }

  func testOutsideRawWriteOfTheShareSidecarIsCapturedAsAnExternalEntry() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let ref = try await fixture.image()
    let store = SMBSidecarStore(source: fixture.source, ref: ref)
    let loaded = try await store.load()
    let sidecar = fixture.share.appendingPathComponent("photo.xmp")
    let existing = try String(contentsOf: sidecar, encoding: .utf8)
    var outside = try XMPParser.parse(existing).0
    outside.saturation = 20
    try XMPSerializer.serialize(
      model: outside, culling: loaded.1, metadata: XMPParser.parseMetadata(existing),
      passthrough: XMPParser.parsePassthrough(existing)
    ).write(to: sidecar, atomically: true, encoding: .utf8)

    var model = loaded.0
    model.exposure = -0.5
    try await store.writeConfirmed(model: model, culling: loaded.1)

    let saved = try shared(fixture)
    let parsed = try XMPParser.parse(saved).0
    XCTAssertEqual(parsed.saturation, 20, accuracy: 1e-9)
    XCTAssertEqual(parsed.exposure, -0.5, accuracy: 1e-9)
    let entries = try history(saved)
    XCTAssertEqual(entries.map(\.action), ["external"])
    XCTAssertEqual(entries.first?.writer, "")
    XCTAssertEqual(
      try XMPParser.parse(XCTUnwrap(entries.first).adjustmentXmp).0.saturation, 20, accuracy: 1e-9)
    XCTAssertEqual(XMPParser.parseMetadata(saved).caption, "Caption A")
    XCTAssertTrue(saved.contains("<foreign:Audit"))
    XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
    await fixture.close()
  }

  func testMergedEditRetriedAfterALostAcknowledgementKeepsItsSingleEntry() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let proxy = try await OwnedSMBPublicationProxy.open(fixture)
    await fixture.source.disconnect()
    try await fixture.source.connect(credentials: proxy.credentials)
    let ref = try await fixture.image()
    let store = SMBSidecarStore(source: fixture.source, ref: ref)
    let loaded = try await store.load()
    let (observer, observedRef) = try await secondClient(fixture)
    let other = SMBSidecarStore(source: observer, ref: observedRef)
    var otherModel = try await other.load().0
    otherModel.contrast = 30
    try await other.writeConfirmed(model: otherModel, culling: loaded.1)

    var model = loaded.0
    model.exposure = 1.5
    try proxy.arm()
    do {
      try await store.commitSemantic(
        model: model, culling: loaded.1, action: "adjustment", label: "Merged exposure")
      XCTFail("The accepted rename's network acknowledgement must be lost")
    } catch {
      XCTAssertTrue(proxy.droppedAcknowledgement)
    }
    let accepted = try shared(fixture)
    let acceptedEntries = try history(accepted)
    XCTAssertEqual(acceptedEntries.map(\.action), ["external", "adjustment"])
    let id = try XCTUnwrap(acceptedEntries.last?.id)

    await fixture.source.disconnect()
    try await fixture.source.connect(credentials: fixture.credentials)
    _ = try await fixture.image()
    await store.flush()
    let retried = try await store.readWorkflowXML()
    XCTAssertEqual(retried, accepted)
    let entries = try history(XCTUnwrap(retried))
    XCTAssertEqual(entries.filter { $0.id == id }.count, 1)
    XCTAssertEqual(entries.count, 2)
    let parsed = try XMPParser.parse(XCTUnwrap(retried)).0
    XCTAssertEqual(parsed.exposure, 1.5, accuracy: 1e-9)
    XCTAssertEqual(parsed.contrast, 30, accuracy: 1e-9)
    XCTAssertEqual(try Data(contentsOf: fixture.raw), fixture.original)
    await observer.disconnect()
    await proxy.close()
    await fixture.close()
  }

  func testMergeIsPublishedForAdoptionAndConfirmationRebasesLaterSaves() async throws {
    let fixture = try await OwnedSMBWorkflowFixture.open(testCase: self)
    let ref = try await fixture.image()
    let store = SMBSidecarStore(source: fixture.source, ref: ref)
    let loaded = try await store.load()
    var adoptions = await store.reconciliations().makeAsyncIterator()
    let (observer, observedRef) = try await secondClient(fixture)
    let other = SMBSidecarStore(source: observer, ref: observedRef)
    var otherModel = try await other.load().0
    otherModel.contrast = 30
    try await other.writeConfirmed(model: otherModel, culling: loaded.1)

    var model = loaded.0
    model.exposure = 1.5
    try await store.commitSemantic(
      model: model, culling: loaded.1, action: "adjustment", label: "Stale exposure")
    let next = await adoptions.next()
    let published = try XCTUnwrap(next)
    XCTAssertEqual(published.xml, try shared(fixture))
    XCTAssertEqual(published.model, model)
    XCTAssertEqual(published.culling, loaded.1)

    await store.confirmAdoption(of: published.xml)
    var adopted = try XMPParser.parse(published.xml).0
    adopted.contrast = 0
    try await store.commitSemantic(
      model: adopted, culling: loaded.1, action: "adjustment", label: "Contrast reset")
    let saved = try shared(fixture)
    XCTAssertEqual(try XMPParser.parse(saved).0.contrast, 0, accuracy: 1e-9)
    XCTAssertEqual(try XMPParser.parse(saved).0.exposure, 1.5, accuracy: 1e-9)
    let entries = try history(saved)
    XCTAssertEqual(entries.map(\.action), ["external", "adjustment", "adjustment"])
    XCTAssertEqual(entries[2].parentId, entries[1].id)
    await observer.disconnect()
    await fixture.close()
  }
}
